import { randomUUID } from "node:crypto";
import {
	CodeModeError,
	type CodeModePolicy,
	type InvocationOptions,
	type InvocationResult,
	type JsonValue,
	type ProgressEvent,
} from "./contracts.ts";
import { mergeLimits, assertPolicy } from "./policy.ts";
import { createRegistry, type Registry } from "./registry.ts";
import { BoundedState, parsePayloads } from "./state.ts";
import { assertTypeChecks } from "./type-checker.ts";
import { QuickJsRuntime, type HostCall } from "./quickjs-runtime.ts";

const jsonSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
const normalizeError = (error: unknown): CodeModeError => {
	if (error instanceof CodeModeError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("__CODE_MODE_ERROR__")) {
		try {
			return new CodeModeError(
				JSON.parse(message.slice("__CODE_MODE_ERROR__".length)) as {
					code: CodeModeError["code"];
					message: string;
					toolId?: string;
					cause?: string;
				},
			);
		} catch {
			/* use the generic error below */
		}
	}
	return new CodeModeError({ code: "runtime-error", message });
};

export interface CodeModeExecutorOptions {
	readonly registry: Registry;
	readonly defaults?: Partial<import("./contracts.ts").InvocationLimits>;
	readonly onProgress?: (event: ProgressEvent) => void;
}
export class CodeModeExecutor {
	readonly #registry: Registry;
	readonly #defaults: Partial<import("./contracts.ts").InvocationLimits>;
	readonly #onProgress: ((event: ProgressEvent) => void) | undefined;
	readonly #runtime = new QuickJsRuntime();
	constructor(options: CodeModeExecutorOptions) {
		this.#registry = options.registry;
		this.#defaults = options.defaults ?? {};
		this.#onProgress = options.onProgress;
	}
	async execute(options: InvocationOptions): Promise<InvocationResult> {
		const started = Date.now();
		const invocationId = options.invocationId ?? randomUUID();
		const progress: ProgressEvent[] = [];
		const logs: string[] = [];
		const emit = (event: ProgressEvent): void => {
			progress.push(event);
			this.#onProgress?.(event);
		};
		try {
			if (!options.code.trim()) throw new CodeModeError({ code: "invalid-input", message: "code must not be empty" });
			assertPolicy(options.policy ?? {});
			const limits = mergeLimits({ ...this.#defaults, ...options.limits });
			const policy = options.policy ?? {};
			const payloads = parsePayloads(options.payloads);
			const state = new BoundedState(options.state, limits.maxStateBytes);
			const visible = this.#registry.discover(undefined, policy);
			const js = assertTypeChecks(options.code, this.#registry.declarations(policy));
			const calls = { count: 0 };
			const toolContext = (
				toolId: string,
			): {
				signal: AbortSignal;
				invocationId: string;
				reportProgress: (event: ProgressEvent) => void;
				state: BoundedState;
			} => ({ signal: options.signal ?? new AbortController().signal, invocationId, reportProgress: emit, state });
			emit({ type: "started", invocationId, at: Date.now() });
			const runtime = await this.#runtime.execute(
				js.javascript,
				visible.map((tool) => tool.id.split(".")[0]!).filter((value, index, all) => all.indexOf(value) === index),
				async (id: string, input: unknown, signal: AbortSignal) => {
					if (id === "tools.search")
						return this.#registry.discover(
							typeof input === "object" &&
								input !== null &&
								typeof (input as Record<string, unknown>).query === "string"
								? ((input as Record<string, unknown>).query as string)
								: "",
							policy,
						);
					if (++calls.count > Math.min(limits.maxToolCalls, policy.maxToolCalls ?? limits.maxToolCalls))
						throw new CodeModeError({
							code: "budget-exceeded",
							message: `Tool-call budget exceeded (${limits.maxToolCalls})`,
							toolId: id,
						});
					emit({ type: "tool-start", invocationId, toolId: id, at: Date.now() });
					const at = Date.now();
					try {
						const value = await this.#registry.invoke(id, input, { ...toolContext(id), signal }, policy);
						emit({ type: "tool-complete", invocationId, toolId: id, at: Date.now(), durationMs: Date.now() - at });
						return value;
					} catch (error) {
						throw normalizeError(error);
					}
				},
				{
					timeoutMs: limits.timeoutMs,
					memoryLimitBytes: limits.memoryLimitBytes,
					maxLogChars: limits.maxLogChars,
					payloads,
					state: state.toJSON(),
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
			logs.push(...runtime.logs);
			for (const log of runtime.logs) emit({ type: "log", invocationId, message: log, at: Date.now() });
			if (runtime.reason !== "completed") {
				if (runtime.error?.startsWith("__CODE_MODE_ERROR__")) throw normalizeError(runtime.error);
				throw new CodeModeError({
					code:
						runtime.reason === "timed-out"
							? "deadline-exceeded"
							: runtime.reason === "cancelled"
								? "cancelled"
								: "runtime-error",
					message: runtime.error ?? "Code mode failed",
				});
			}
			if (jsonSize(runtime.value) > limits.maxOutputChars)
				throw new CodeModeError({ code: "result-too-large", message: `Result exceeds ${limits.maxOutputChars} bytes` });
			for (const [key, value] of Object.entries(runtime.state)) state.set(key, value as JsonValue);
			emit({ type: "completed", invocationId, at: Date.now() });
			return {
				ok: true,
				value: runtime.value,
				logs,
				progress,
				state: state.toJSON(),
				toolCalls: calls.count,
				durationMs: Date.now() - started,
			};
		} catch (error) {
			const normalized = normalizeError(error);
			return {
				ok: false,
				error: normalized.toJSON(),
				logs,
				progress,
				state: {},
				toolCalls: 0,
				durationMs: Date.now() - started,
			};
		}
	}
}
export const executeCodeMode = (
	options: InvocationOptions & { readonly registry: Registry },
): Promise<InvocationResult> => new CodeModeExecutor({ registry: options.registry }).execute(options);
export const codeMode = (
	registry: Registry = createRegistry(),
	options?: Omit<InvocationOptions, "code"> & { code: string },
): Promise<InvocationResult> => new CodeModeExecutor({ registry }).execute(options ?? { code: "return undefined;" });
