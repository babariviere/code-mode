export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** JSON Schema is intentionally structural so hosts can use schemas from any validator. */
export type JsonSchema<T = unknown> = {
	readonly type?: string;
	readonly title?: string;
	readonly description?: string;
	readonly properties?: Record<string, JsonSchema>;
	readonly required?: readonly string[];
	readonly items?: JsonSchema;
	readonly additionalProperties?: boolean | JsonSchema;
	readonly enum?: readonly JsonValue[];
	readonly [key: string]: unknown;
} & { readonly __type?: T };

export type ToolEffect = "none" | "workspace-write" | "external";
export type ToolId = `${string}.${string}`;

export interface CodeModeToolContext {
	readonly signal: AbortSignal;
	readonly invocationId: string;
	readonly reportProgress: (event: ProgressEvent) => void;
	readonly state: InvocationState;
}

export interface CodeModeTool<TInput = unknown, TOutput = unknown> {
	readonly id: ToolId;
	readonly description: string;
	readonly inputSchema: JsonSchema<TInput>;
	readonly outputSchema?: JsonSchema<TOutput>;
	readonly effect: ToolEffect;
	readonly capabilities?: readonly string[];
	readonly execute: (input: TInput, context: CodeModeToolContext) => Promise<TOutput> | TOutput;
}

export interface ToolSummary {
	readonly id: ToolId;
	readonly description: string;
	readonly effect: ToolEffect;
	readonly capabilities: readonly string[];
	readonly inputSchema: JsonSchema;
	readonly outputSchema?: JsonSchema;
}

export interface CodeModePolicy {
	readonly allowedTools?: readonly string[];
	readonly allowedCapabilities?: readonly string[];
	readonly deniedTools?: readonly string[];
	readonly allowedEffects?: readonly ToolEffect[];
	readonly maxToolCalls?: number;
}

export interface InvocationLimits {
	readonly timeoutMs: number;
	readonly maxToolCalls: number;
	readonly maxDiscoveryCalls: number;
	readonly maxCodeChars: number;
	readonly maxPayloadBytes: number;
	readonly maxDeclarationChars: number;
	readonly maxToolInputBytes: number;
	readonly maxToolOutputChars: number;
	readonly maxOutputChars: number;
	readonly maxLogChars: number;
	readonly memoryLimitBytes: number;
	readonly maxStateBytes: number;
}

export interface InvocationOptions {
	readonly code: string;
	readonly payloads?: Record<string, JsonValue | string>;
	readonly state?: Record<string, JsonValue>;
	readonly limits?: Partial<InvocationLimits>;
	readonly policy?: CodeModePolicy;
	readonly signal?: AbortSignal;
	readonly invocationId?: string;
	readonly resultFormat?: "auto" | "yaml" | "json" | "text";
}

export type ProgressEvent =
	| { readonly type: "started"; readonly invocationId: string; readonly at: number }
	| { readonly type: "tool-start"; readonly invocationId: string; readonly toolId: string; readonly at: number }
	| {
			readonly type: "tool-complete";
			readonly invocationId: string;
			readonly toolId: string;
			readonly at: number;
			readonly durationMs: number;
	  }
	| { readonly type: "log"; readonly invocationId: string; readonly message: string; readonly at: number }
	| { readonly type: "completed"; readonly invocationId: string; readonly at: number };

export type CodeModeErrorCode =
	| "invalid-input"
	| "type-error"
	| "policy-denied"
	| "tool-not-found"
	| "tool-error"
	| "budget-exceeded"
	| "deadline-exceeded"
	| "cancelled"
	| "runtime-error"
	| "result-too-large";

export interface CodeModeErrorShape {
	readonly code: CodeModeErrorCode;
	readonly message: string;
	readonly toolId?: string;
	readonly details?: JsonValue;
	readonly cause?: string;
}

export class CodeModeError extends Error {
	readonly code: CodeModeErrorCode;
	readonly toolId: string | undefined;
	readonly details: JsonValue | undefined;
	constructor(shape: CodeModeErrorShape) {
		super(shape.message);
		this.name = "CodeModeError";
		this.code = shape.code;
		if (shape.toolId !== undefined) this.toolId = shape.toolId;
		if (shape.details !== undefined) this.details = shape.details;
		if (shape.cause !== undefined) this.cause = shape.cause;
	}
	toJSON(): CodeModeErrorShape {
		return {
			code: this.code,
			message: this.message,
			...(this.toolId === undefined ? {} : { toolId: this.toolId }),
			...(this.details === undefined ? {} : { details: this.details }),
			...(typeof this.cause === "string" ? { cause: this.cause } : {}),
		};
	}
}

export const isJsonValue = (value: unknown): value is JsonValue =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "boolean" ||
	(Array.isArray(value)
		? value.every(isJsonValue)
		: typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue));

export interface InvocationState {
	get<T extends JsonValue = JsonValue>(key: string): T | undefined;
	set(key: string, value: JsonValue): void;
	delete(key: string): boolean;
	entries(): ReadonlyArray<readonly [string, JsonValue]>;
}

export interface InvocationResult {
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: CodeModeErrorShape;
	readonly logs: readonly string[];
	readonly progress: readonly ProgressEvent[];
	readonly state: Readonly<Record<string, JsonValue>>;
	readonly toolCalls: number;
	readonly durationMs: number;
	readonly formatted?: string;
}
