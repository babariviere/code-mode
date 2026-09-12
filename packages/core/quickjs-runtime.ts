import { randomBytes } from "node:crypto";
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { runAbortable, settleWithin } from "./async-settlement.ts";
import { ENTROPY_POOL_BYTES, guestPolyfillPlan } from "./guest-polyfills.ts";
import { type GuestSourceMap, mapGuestErrorText, parseGuestSourceMap } from "./source-map.ts";
import { transpileSpindleCode } from "./type-checker-rich.ts";

export type SpindleSandboxTerminationReason = "completed" | "runtime_error" | "timed_out" | "aborted";

export interface SpindleSandboxResult {
	value: unknown;
	logs: string[];
	terminationReason: SpindleSandboxTerminationReason;
	error?: string;
}

export interface SpindleSandboxOptions {
	/** Trusted host bootstrap, evaluated before untrusted guest code. */
	setup: string;
	/** JSON-compatible host bootstrap data. Never copied from model options. */
	bindings?: Readonly<Record<string, unknown>>;
	timeoutMs: number;
	memoryLimitBytes: number;
	maxLogChars?: number;
	payloads?: Record<string, string>;
	/**
	 * JSON text of the source map for `transpiledCode`, used to rewrite guest
	 * stack positions back to the program the model wrote. Ignored when the
	 * runtime transpiles `code` itself (it then uses its own emitted map).
	 */
	sourceMap?: string;
	signal?: AbortSignal;
	/**
	 * Install the host-API polyfill layer (runtime/guest-polyfills.ts). Defaults
	 * to true. Tests that assert what the bare engine ships set it to false.
	 */
	polyfills?: boolean;
	minimumTimeoutMsForHostCall?(ref: string, args: Record<string, unknown>): number | undefined;
	/** Optional structured metadata attached to host errors. */
	hostErrorMetadata?(ref: string, error: unknown): Record<string, unknown> | undefined;
	hostErrorMetadataProperty?: string;
	transpiledCode?: string;
}

export type SpindleHostCall = (ref: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsModulePromise: Promise<QuickJsModule> | undefined;

const quickJsModule = (): Promise<QuickJsModule> => {
	quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
	return quickJsModulePromise;
};

const formatValue = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	// QuickJS Error values arrive from context.dump() as plain objects holding
	// name/message/stack; render them like a real Error instead of raw JSON so
	// the failure text reads "Error: boom" plus frames, not an escaped blob.
	if (typeof value === "object" && value !== null) {
		const record = value as { name?: unknown; message?: unknown; stack?: unknown };
		if (typeof record.message === "string" && (typeof record.stack === "string" || typeof record.name === "string")) {
			const head = `${String(record.name)}: ${record.message}`;
			return typeof record.stack === "string" && record.stack.length > 0 ? `${head}\n${record.stack}` : head;
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const jsonText = (value: unknown): string => {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "null";
	return serialized;
};

const jsonHandle = (context: any, jsonObject: any, jsonParse: any, value: unknown): any => {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "string") return context.newString(value);
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") {
		return Number.isFinite(value) ? context.newNumber(value) : context.null;
	}
	const serialized = context.newString(jsonText(value));
	try {
		return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized));
	} finally {
		serialized.dispose();
	}
};

const HOST_TASK_SETTLE_GRACE_MS = 250;

/**
 * QuickJS call-stack ceiling for a guest program. Without it a deeply recursive
 * program exhausts the host stack instead of raising a guest RangeError.
 */
const QUICKJS_MAX_STACK_SIZE_BYTES = 256 * 1024;

export class QuickJsRuntime {
	async execute(
		code: string,
		hostCall: SpindleHostCall,
		options: SpindleSandboxOptions,
	): Promise<SpindleSandboxResult> {
		if (options.signal?.aborted) {
			return {
				value: undefined,
				logs: [],
				terminationReason: "aborted",
				error: "Execution cancelled",
			};
		}
		if (
			!Number.isSafeInteger(options.memoryLimitBytes) ||
			options.memoryLimitBytes < 1 ||
			options.memoryLimitBytes > 0xffff_ffff
		) {
			return {
				value: undefined,
				logs: [],
				terminationReason: "runtime_error",
				error: "QuickJS memory limit must be an integer between 1 byte and 4294967295 bytes (WASM32 maximum)",
			};
		}
		const module = await quickJsModule();
		const context = module.newContext();
		const runtime = context.runtime;
		const jsonObject = context.getProp(context.global, "JSON");
		const jsonParse = context.getProp(jsonObject, "parse");
		const executionStartedAt = Date.now();
		let effectiveTimeoutMs = options.timeoutMs;
		let executionDeadlineAt = executionStartedAt + effectiveTimeoutMs;
		let interruptedByDeadline = false;
		runtime.setMemoryLimit(options.memoryLimitBytes);
		// Runaway guest recursion otherwise walks the host stack until the process
		// crashes; a bounded QuickJS stack turns it into a catchable guest error.
		runtime.setMaxStackSize(QUICKJS_MAX_STACK_SIZE_BYTES);
		runtime.setInterruptHandler(() => {
			if (options.signal?.aborted === true) return true;
			if (Date.now() <= executionDeadlineAt) return false;
			interruptedByDeadline = true;
			return true;
		});
		const logs: string[] = [];
		const maxLogChars = options.maxLogChars ?? 100_000;
		let logChars = 0;
		let logsTruncated = false;
		const pendingHostPromises = new Set<any>();
		const hostTasks = new Set<Promise<void>>();
		const pendingTimers = new Set<NodeJS.Timeout>();
		let closing = false;
		let cancelled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		let rejectDeadline: ((error: Error) => void) | undefined;
		let abortHandler: (() => void) | undefined;
		let activePromiseHandle: any;
		let executionGate: any;
		let pendingResolution: Promise<any> | undefined;
		const hostAbortController = new AbortController();
		const abortHostCalls = (reason: string): void => {
			if (!hostAbortController.signal.aborted) {
				hostAbortController.abort(new Error(reason));
			}
		};

		const rejectExecutionGate = (message: string): void => {
			if (!executionGate || executionGate.alive === false) return;
			const errorHandle = context.newError(message);
			executionGate.reject(errorHandle);
			errorHandle.dispose();
			runtime.executePendingJobs();
		};

		const timeoutMessage = (): string => `Execution timed out after ${effectiveTimeoutMs}ms`;
		const expireDeadline = (): void => {
			if (closing || cancelled || timedOut) return;
			timedOut = true;
			const message = timeoutMessage();
			abortHostCalls(message);
			rejectExecutionGate(message);
			rejectDeadline?.(new Error(message));
		};
		const scheduleDeadline = (): void => {
			if (!rejectDeadline || closing || cancelled || timedOut) return;
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(expireDeadline, Math.max(0, executionDeadlineAt - Date.now()));
		};
		const extendExecutionTimeout = (ref: string, args: Record<string, unknown>): void => {
			const requestedTimeoutMs = options.minimumTimeoutMsForHostCall?.(ref, args);
			if (typeof requestedTimeoutMs !== "number" || !Number.isFinite(requestedTimeoutMs)) {
				return;
			}
			const requestedDurationMs = Math.max(1, Math.floor(requestedTimeoutMs));
			const nextDeadlineAt = Date.now() + requestedDurationMs;
			const nextTimeoutMs = nextDeadlineAt - executionStartedAt;
			if (nextDeadlineAt <= executionDeadlineAt) return;
			effectiveTimeoutMs = nextTimeoutMs;
			executionDeadlineAt = nextDeadlineAt;
			scheduleDeadline();
		};

		/**
		 * In-flight host calls the guest may cancel, keyed by the id the guest
		 * generated. Only calls that carried a signal appear here.
		 */
		const callControllers = new Map<number, AbortController>();

		try {
			const hostFunction = context.newFunction("__spindleHostCall", (referenceHandle: any, argsHandle: any) => {
				const reference = context.getString(referenceHandle);
				const dumpedArgs = context.dump(argsHandle);
				const args =
					typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
						? (dumpedArgs as Record<string, unknown>)
						: {};
				const callIdValue = args.__spindleCallId;
				const callId = typeof callIdValue === "number" ? callIdValue : undefined;
				if (callId !== undefined) delete args.__spindleCallId;
				extendExecutionTimeout(reference, args);
				const promise = context.newPromise();
				pendingHostPromises.add(promise);
				void promise.settled.then(() => pendingHostPromises.delete(promise));
				if (reference === "spindle.$timer") {
					const ms = Math.max(0, Number(args.ms ?? 0));
					const timer = setTimeout(() => {
						if (closing || promise.alive === false) return;
						promise.resolve(context.undefined);
						runtime.executePendingJobs();
					}, ms);
					timer.unref?.();
					pendingTimers.add(timer);
					void promise.settled.then(() => pendingTimers.delete(timer));
					return promise.handle;
				}
				// Guest-initiated cancellation of one in-flight call. Resolved through a
				// zero-delay timer for the same reason spindle.$timer is: settling a
				// promise from inside newFunction needs a pending-jobs pump afterwards.
				if (reference === "spindle.$cancel") {
					callControllers.get(Number(args.callId))?.abort(new Error("The host call was cancelled by the guest"));
					const timer = setTimeout(() => {
						if (closing || promise.alive === false) return;
						promise.resolve(context.undefined);
						runtime.executePendingJobs();
					}, 0);
					timer.unref?.();
					pendingTimers.add(timer);
					void promise.settled.then(() => pendingTimers.delete(timer));
					return promise.handle;
				}
				// A cancellable call gets its own controller, chained to the
				// program-wide one so a deadline or an outer abort still reaches it.
				let callSignal = hostAbortController.signal;
				if (callId !== undefined) {
					const controller = new AbortController();
					const onProgramAbort = (): void => controller.abort(hostAbortController.signal.reason);
					if (hostAbortController.signal.aborted) onProgramAbort();
					else hostAbortController.signal.addEventListener("abort", onProgramAbort, { once: true });
					callControllers.set(callId, controller);
					callSignal = controller.signal;
					void promise.settled.then(() => {
						callControllers.delete(callId);
						hostAbortController.signal.removeEventListener("abort", onProgramAbort);
					});
				}
				const task = runAbortable(callSignal, () => hostCall(reference, args, callSignal))
					.then((value) => {
						if (closing || promise.alive === false) return;
						const handle = jsonHandle(context, jsonObject, jsonParse, value);
						promise.resolve(handle);
						handle.dispose();
					})
					.catch((error) => {
						if (closing || promise.alive === false) return;
						const errorHandle = context.newError(error instanceof Error ? error.message : String(error));
						// Structured host errors need not depend on rendered error text.
						const exit = options.hostErrorMetadata?.(reference, error);
						if (exit) {
							const metadata = jsonHandle(context, jsonObject, jsonParse, exit);
							context.setProp(errorHandle, options.hostErrorMetadataProperty ?? "__codeModeHostError", metadata);
							metadata.dispose();
						}
						promise.reject(errorHandle);
						errorHandle.dispose();
					})
					.finally(() => {
						if (!closing) runtime.executePendingJobs();
					});
				hostTasks.add(task);
				void task.finally(() => hostTasks.delete(task));
				return promise.handle;
			});
			context.setProp(context.global, "__spindleHostCall", hostFunction);
			hostFunction.dispose();

			const printFunction = context.newFunction("print", (...handles: any[]) => {
				if (logsTruncated) return;
				const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
				const remaining = maxLogChars - logChars;
				if (line.length > remaining) {
					if (remaining > 0) logs.push(line.slice(0, remaining));
					logs.push("[Code mode log output truncated]");
					logsTruncated = true;
					return;
				}
				logs.push(line);
				logChars += line.length;
			});
			context.setProp(context.global, "print", printFunction);
			printFunction.dispose();

			const payloads = jsonHandle(context, jsonObject, jsonParse, options.payloads ?? {});
			context.setProp(context.global, "π", payloads);
			payloads.dispose();

			for (const [name, value] of Object.entries(options.bindings ?? {})) {
				const binding = jsonHandle(context, jsonObject, jsonParse, value);
				context.setProp(context.global, name, binding);
				binding.dispose();
			}

			// The polyfill layer is selected from the program text and evaluated as
			// part of setup, so a program that never mentions URL never pays to
			// parse a URL parser (newContext() runs per execute() call).
			const polyfills =
				options.polyfills === false ? { source: "", names: [], needsEntropy: false } : guestPolyfillPlan(code);
			if (polyfills.needsEntropy) {
				// crypto.getRandomValues must be synchronous and every host call here
				// is async, so real entropy is injected up front rather than fetched
				// on demand. The guest deletes the global as it reads it.
				const entropy = context.newString(randomBytes(ENTROPY_POOL_BYTES).toString("hex"));
				context.setProp(context.global, "__spindleEntropy", entropy);
				entropy.dispose();
			}
			const setupResult = context.evalCode(options.setup + polyfills.source, "code-mode-setup.js");
			if (setupResult.error) {
				const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatValue(context.dump(setupResult.error));
				setupResult.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
					error,
				};
			}
			setupResult.value.dispose();

			executionGate = context.newPromise();
			context.setProp(context.global, "__spindleExecutionGate", executionGate.handle);
			// When the caller supplies the transpiled code it must supply its map
			// too (a self-transpiled map would not match); otherwise transpile here
			// and keep the emitted map for error-position translation.
			let sourceMap: GuestSourceMap | undefined;
			let guestProgram: string;
			if (options.transpiledCode !== undefined) {
				guestProgram = options.transpiledCode;
				sourceMap = parseGuestSourceMap(options.sourceMap);
			} else {
				const transpiled = transpileSpindleCode(code);
				guestProgram = transpiled.javascript;
				sourceMap = parseGuestSourceMap(options.sourceMap ?? transpiled.sourceMap);
			}
			// Guest stack frames point into the emitted JS; rewrite them to the
			// user's program coordinates so the reported line is the line written.
			const formatGuestError = (handle: any): string => mapGuestErrorText(formatValue(context.dump(handle)), sourceMap);
			const wrappedCode = `${guestProgram}\nPromise.race([__piSpindleMain(), globalThis.__spindleExecutionGate])`;
			const evaluation = context.evalCode(wrappedCode, "pi-spindle-guest.js");
			runtime.executePendingJobs();
			if (evaluation.error) {
				const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatGuestError(evaluation.error);
				evaluation.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
					error,
				};
			}

			activePromiseHandle = evaluation.value;
			const cancellation = new Promise<never>((_resolve, reject) => {
				abortHandler = () => {
					cancelled = true;
					hostAbortController.abort(options.signal?.reason);
					rejectExecutionGate("Execution cancelled");
					reject(new Error("Execution cancelled"));
				};
				if (options.signal?.aborted) abortHandler();
				else options.signal?.addEventListener("abort", abortHandler, { once: true });
			});
			void cancellation.catch(() => undefined);
			const deadline = new Promise<never>((_resolve, reject) => {
				rejectDeadline = reject;
				scheduleDeadline();
			});
			pendingResolution = context.resolvePromise(activePromiseHandle);
			runtime.executePendingJobs();
			const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
			pendingResolution = undefined;
			activePromiseHandle.dispose();
			activePromiseHandle = undefined;
			if (resolution.error) {
				const deadlineExceeded = timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatGuestError(resolution.error);
				resolution.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
					error,
				};
			}
			const value = context.dump(resolution.value);
			resolution.value.dispose();
			return { value, logs, terminationReason: "completed" };
		} catch (error) {
			const deadlineExceeded = timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
			if (deadlineExceeded) timedOut = true;
			abortHostCalls(error instanceof Error ? error.message : String(error));
			return {
				value: undefined,
				logs,
				terminationReason: cancelled ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
				error: cancelled
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: error instanceof Error
							? error.message
							: String(error),
			};
		} finally {
			if (timeout) clearTimeout(timeout);
			for (const timer of pendingTimers) clearTimeout(timer);
			if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
			if (hostTasks.size > 0) {
				const settled = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
				if (!settled) {
					abortHostCalls("Spindle guest execution ended before its host calls settled");
					await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
				}
				runtime.executePendingJobs();
			}
			closing = true;
			if (timedOut || cancelled || pendingHostPromises.size > 0) {
				const cleanupMessage = cancelled
					? "Execution cancelled"
					: timedOut
						? timeoutMessage()
						: "Spindle guest execution ended before its host calls settled";
				if (!hostAbortController.signal.aborted) hostAbortController.abort(new Error(cleanupMessage));
				rejectExecutionGate(cleanupMessage);
				const errorHandle = context.newError(cleanupMessage);
				for (const promise of pendingHostPromises) promise.reject(errorHandle);
				errorHandle.dispose();
				runtime.executePendingJobs();
				await new Promise((resolve) => setImmediate(resolve));
				const settled = await Promise.race<any>([
					pendingResolution ? pendingResolution.catch(() => undefined) : Promise.resolve(undefined),
					new Promise<undefined>((resolve) => {
						const timer = setTimeout(() => resolve(undefined), 1_000);
						timer.unref?.();
					}),
				]);
				if (settled?.error) settled.error.dispose();
				if (settled?.value) settled.value.dispose();
				for (const promise of pendingHostPromises) {
					if (promise.alive !== false) promise.dispose();
				}
			}
			if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
			if (executionGate?.alive !== false) executionGate?.dispose();
			runtime.executePendingJobs();
			jsonParse.dispose();
			jsonObject.dispose();
			context.dispose();
		}
	}
}
