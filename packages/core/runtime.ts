import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { JsonValue } from "./contracts.ts";

export interface QuickJsOptions {
	readonly timeoutMs: number;
	readonly memoryLimitBytes: number;
	readonly maxLogChars: number;
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
const toJsonHandle = (context: AnyContext, value: unknown): any => {
	const json = JSON.stringify(value === undefined ? null : value);
	const text = context.newString(json === undefined ? "null" : json);
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
 globalThis.__codeModeNamespaces.forEach((namespace) => {
   namespaces[namespace] = new Proxy({}, { get: (_target, property) => (...args) => call(namespace + "." + String(property), args[0] ?? {}) });
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
		namespaces: readonly string[],
		hostCall: HostCall,
		options: QuickJsOptions,
	): Promise<QuickJsResult> {
		if (options.signal?.aborted)
			return { value: undefined, state: options.state, logs: [], reason: "cancelled", error: "Execution cancelled" };
		const quickjs = await getModule();
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
			deadlineTimer = setTimeout(() => {
				timedOut = true;
				fail(`Execution timed out after ${options.timeoutMs}ms`);
			}, options.timeoutMs);
			deadlineTimer.unref?.();
			const abort = (): void => {
				cancelled = true;
				fail("Execution cancelled");
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			const bridge = context.newFunction("__codeModeHostCall", (idHandle: any, inputHandle: any) => {
				const id = context.getString(idHandle);
				const input = context.dump(inputHandle);
				const promise = context.newPromise();
				pending.add(promise);
				const task = (async () => {
					try {
						const value = await hostCall(id, input, controller.signal);
						if (!closing && promise.alive !== false) {
							const handle = toJsonHandle(context, value);
							promise.resolve(handle);
							handle.dispose();
						}
					} catch (error) {
						if (!closing && promise.alive !== false) {
							const handle = context.newError(error instanceof Error ? error.message : String(error));
							promise.reject(handle);
							handle.dispose();
						}
					} finally {
						pending.delete(promise);
						if (!closing) runtime.executePendingJobs();
					}
				})();
				tasks.add(task);
				void task.finally(() => tasks.delete(task));
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
				["__codeModeNamespaces", namespaces],
				["__codeModePayloads", options.payloads],
				["__codeModeState", options.state],
			] as const) {
				const handle = toJsonHandle(context, value);
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
				`${code}\nPromise.resolve(typeof __codeModeMain === "function" ? __codeModeMain() : undefined)`,
				"code-mode-guest.js",
			);
			if (evaluated.error) {
				const message = String(context.dump(evaluated.error));
				evaluated.error.dispose();
				return { value: undefined, state: options.state, logs, reason: "runtime-error", error: message };
			}
			active = evaluated.value;
			runtime.executePendingJobs();
			const resolution = await Promise.race([
				context.resolvePromise(active),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline")), options.timeoutMs + 10)),
			]);
			if (resolution.error) {
				const message = String(context.dump(resolution.error));
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
			await Promise.allSettled([...tasks]);
			active?.dispose?.();
			runtime.executePendingJobs();
			context.dispose();
		}
	}
}
