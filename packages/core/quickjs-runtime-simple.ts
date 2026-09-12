import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { CodeModeError, type JsonValue } from "./contracts.ts";
import { serializeBounded } from "./serialization.ts";

export interface QuickJsOptions {
	readonly timeoutMs: number;
	readonly memoryLimitBytes: number;
	readonly maxLogChars: number;
	readonly maxToolOutputChars: number;
	readonly payloads: Record<string, JsonValue | string>;
	readonly state: Record<string, JsonValue>;
	readonly signal?: AbortSignal;
}
export interface QuickJsResult {
	readonly value: unknown;
	readonly state: Record<string, JsonValue>;
	readonly logs: readonly string[];
	readonly reason: "completed" | "runtime-error" | "timed-out" | "cancelled";
	readonly error?: string;
}
export type HostCall = (id: string, input: unknown, signal: AbortSignal) => Promise<unknown>;

type AnyContext = any;
let modulePromise: Promise<any> | undefined;
const getModule = (): Promise<any> => (modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant));
const waitForModule = (signal: AbortSignal | undefined, timeoutMs: number): Promise<any> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Execution timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		const onAbort = (): void => {
			cleanup();
			reject(new Error("Execution cancelled"));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		getModule().then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
const toJsonHandle = (context: AnyContext, value: unknown, maxChars: number, label: string): any => {
	const json = serializeBounded(value, maxChars, label);
	const text = context.newString(json);
	const jsonObject = context.getProp(context.global, "JSON");
	const parse = context.getProp(jsonObject, "parse");
	try {
		return context.unwrapResult(context.callFunction(parse, jsonObject, text));
	} finally {
		text.dispose();
		jsonObject.dispose();
		parse.dispose();
	}
};
const setup = `
(() => {
 const bridge = globalThis.__codeModeHostCall; delete globalThis.__codeModeHostCall;
 const call = (id, input) => bridge(id, input ?? {});
 const namespaces = Object.create(null);
 const bindings = Object.create(null);
 globalThis.__codeModeBindings.forEach(({namespace, name, id}) => {
   bindings[namespace + "." + name] = id;
   if (!namespaces[namespace]) namespaces[namespace] = new Proxy({}, { get: (_target, property) => (...args) => call(bindings[namespace + "." + String(property)] ?? "", args[0] ?? {}) });
   globalThis[namespace] = namespaces[namespace];
 });
 globalThis.tools = Object.freeze({ search: (input) => call("tools.search", input ?? {}) });
 globalThis.π = Object.freeze(globalThis.__codeModePayloads ?? {}); delete globalThis.__codeModePayloads;
 globalThis.τ = globalThis.__codeModeState ?? {}; delete globalThis.__codeModeState;
 globalThis.process = Object.freeze({ env: Object.freeze({}), platform: "quickjs", arch: "wasm32", cwd: "/" });
 delete globalThis.__codeModeNamespaces;
})();`;

export class QuickJsRuntime {
	async execute(
		code: string,
		bindings: readonly { namespace: string; name: string; id: string }[],
		hostCall: HostCall,
		options: QuickJsOptions,
	): Promise<QuickJsResult> {
		if (options.signal?.aborted)
			return { value: undefined, state: options.state, logs: [], reason: "cancelled", error: "Execution cancelled" };
		let quickjs: any;
		try {
			quickjs = await waitForModule(options.signal, options.timeoutMs);
		} catch (error) {
			return {
				value: undefined,
				state: options.state,
				logs: [],
				reason: options.signal?.aborted ? "cancelled" : "timed-out",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (options.signal?.aborted)
			return { value: undefined, state: options.state, logs: [], reason: "cancelled", error: "Execution cancelled" };
		const context: AnyContext = quickjs.newContext();
		const runtime = context.runtime;
		const logs: string[] = [];
		let logChars = 0;
		let closing = false;
		let timedOut = false;
		let cancelled = false;
		const pending = new Set<any>();
		const tasks = new Set<Promise<unknown>>();
		const controller = new AbortController();
		let deadlineTimer: NodeJS.Timeout | undefined;
		let active: any;
		let executionGate: any;
		let abortHandler: (() => void) | undefined;
		const fail = (message: string): void => {
			if (!controller.signal.aborted) controller.abort(new Error(message));
		};
		try {
			runtime.setMemoryLimit(options.memoryLimitBytes);
			runtime.setMaxStackSize(256 * 1024);
			runtime.setInterruptHandler(() => {
				if (options.signal?.aborted) {
					cancelled = true;
					return true;
				}
				if (Date.now() >= deadlineAt) {
					timedOut = true;
					return true;
				}
				return false;
			});
			const started = Date.now();
			const deadlineAt = started + options.timeoutMs;
			executionGate = context.newPromise();
			context.setProp(context.global, "__codeModeExecutionGate", executionGate.handle);
			const rejectGate = (message: string): void => {
				if (executionGate?.alive !== false) {
					const errorHandle = context.newError(message);
					executionGate.reject(errorHandle);
					errorHandle.dispose();
					runtime.executePendingJobs();
				}
			};
			deadlineTimer = setTimeout(() => {
				timedOut = true;
				fail(`Execution timed out after ${options.timeoutMs}ms`);
				rejectGate(`Execution timed out after ${options.timeoutMs}ms`);
			}, options.timeoutMs);
			deadlineTimer.unref?.();
			abortHandler = (): void => {
				cancelled = true;
				fail("Execution cancelled");
				rejectGate("Execution cancelled");
			};
			if (abortHandler) options.signal?.addEventListener("abort", abortHandler, { once: true });
			const bridge = context.newFunction("__codeModeHostCall", (idHandle: any, inputHandle: any) => {
				const id = context.getString(idHandle);
				const input = context.dump(inputHandle);
				const promise = context.newPromise();
				pending.add(promise);
				void promise.settled.then(() => {
					pending.delete(promise);
					if (!closing && promise.alive !== false) promise.dispose();
				});
				const task = (async () => {
					try {
						const value = await hostCall(id, input, controller.signal);
						if (!closing && promise.alive !== false) {
							const handle = toJsonHandle(context, value, options.maxToolOutputChars, "tool output");
							promise.resolve(handle);
							handle.dispose();
						}
					} catch (error) {
						if (!closing && promise.alive !== false) {
							const message =
								error instanceof CodeModeError
									? `__CODE_MODE_ERROR__${JSON.stringify(error.toJSON())}`
									: error instanceof Error
										? error.message
										: String(error);
							const handle = context.newError(message);
							promise.reject(handle);
							handle.dispose();
						}
					} finally {
						if (!closing) runtime.executePendingJobs();
					}
				})();
				tasks.add(task);
				task.then(
					() => tasks.delete(task),
					() => tasks.delete(task),
				);
				return promise.handle;
			});
			context.setProp(context.global, "__codeModeHostCall", bridge);
			bridge.dispose();
			const print = context.newFunction("print", (...handles: any[]) => {
				if (logChars >= options.maxLogChars) return;
				const line = handles.map((handle: any) => String(context.dump(handle))).join(" ");
				const remaining = options.maxLogChars - logChars;
				logs.push(line.slice(0, remaining));
				logChars += Math.min(line.length, remaining);
			});
			context.setProp(context.global, "print", print);
			print.dispose();
			for (const [name, value] of [
				["__codeModeBindings", bindings],
				["__codeModePayloads", options.payloads],
				["__codeModeState", options.state],
			] as const) {
				const handle = toJsonHandle(context, value, options.maxToolOutputChars, name);
				context.setProp(context.global, name, handle);
				handle.dispose();
			}
			const setupResult = context.evalCode(setup, "code-mode-setup.js");
			if (setupResult.error) {
				const message = String(context.dump(setupResult.error));
				setupResult.error.dispose();
				return { value: undefined, state: options.state, logs, reason: "runtime-error", error: message };
			}
			setupResult.value.dispose();
			const evaluated = context.evalCode(
				`${code}\nPromise.race([Promise.resolve(typeof __codeModeMain === "function" ? __codeModeMain() : undefined), globalThis.__codeModeExecutionGate])`,
				"code-mode-guest.js",
			);
			if (evaluated.error) {
				const message = String(context.dump(evaluated.error));
				evaluated.error.dispose();
				return { value: undefined, state: options.state, logs, reason: "runtime-error", error: message };
			}
			active = evaluated.value;
			// Promise.race and an async function can require more than one QuickJS job turn
			// when the program has no host call to drive the bridge.
			for (let i = 0; i < 100; i++) runtime.executePendingJobs();
			let fallbackTimer: NodeJS.Timeout | undefined;
			const fallback = new Promise<never>((_, reject) => {
				fallbackTimer = setTimeout(() => reject(new Error("deadline")), options.timeoutMs + 10);
				fallbackTimer.unref?.();
			});
			const resolved = context.resolvePromise(active);
			for (let i = 0; i < 100; i++) runtime.executePendingJobs();
			const resolution = await Promise.race([resolved, fallback]);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			if (resolution.error) {
				const dumped = context.dump(resolution.error);
				const message =
					dumped && typeof dumped === "object" && "message" in dumped
						? String((dumped as { message: unknown }).message)
						: String(dumped);
				resolution.error.dispose();
				return {
					value: undefined,
					state: options.state,
					logs,
					reason: timedOut ? "timed-out" : cancelled ? "cancelled" : "runtime-error",
					error: message,
				};
			}
			const value = context.dump(resolution.value);
			resolution.value.dispose();
			const stateEval = context.evalCode("JSON.stringify(globalThis.τ)");
			const state = stateEval.error
				? options.state
				: (JSON.parse(String(context.dump(stateEval.value))) as Record<string, JsonValue>);
			if (stateEval.error) stateEval.error.dispose();
			else stateEval.value.dispose();
			return { value, state, logs, reason: "completed" };
		} catch (error) {
			const reason = cancelled || options.signal?.aborted ? "cancelled" : timedOut ? "timed-out" : "runtime-error";
			return {
				value: undefined,
				state: options.state,
				logs,
				reason,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			closing = true;
			if (deadlineTimer) clearTimeout(deadlineTimer);
			if (!controller.signal.aborted) controller.abort(new Error("Execution ended"));
			for (const promise of pending) {
				if (promise.alive !== false) {
					const handle = context.newError("Execution ended");
					promise.reject(handle);
					handle.dispose();
					promise.dispose();
				}
			}
			if (executionGate?.alive !== false) {
				const errorHandle = context.newError("Execution ended");
				executionGate.reject(errorHandle);
				errorHandle.dispose();
			}
			executionGate?.dispose?.();
			if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
			active?.dispose?.();
			if (!closing) runtime.executePendingJobs();
			context.dispose();
		}
	}
}
