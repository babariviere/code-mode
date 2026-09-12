import {
	CodeModeError,
	type CodeModePolicy,
	type CodeModeTool,
	type ToolEffect,
	type InvocationLimits,
} from "./contracts.ts";
import { toolAllowed } from "./registry.ts";

export const DEFAULT_LIMITS = Object.freeze({
	timeoutMs: 30_000,
	maxToolCalls: 32,
	maxOutputChars: 100_000,
	maxLogChars: 20_000,
	memoryLimitBytes: 64 * 1024 * 1024,
	maxStateBytes: 64 * 1024,
});
export const mergeLimits = (limits: Partial<InvocationLimits> = {}): InvocationLimits => {
	const merged = { ...DEFAULT_LIMITS, ...limits };
	for (const [key, value] of Object.entries(merged))
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new CodeModeError({ code: "invalid-input", message: `Invalid limit ${key}: ${value}` });
	return merged;
};
export const assertPolicy = (policy: CodeModePolicy): void => {
	if (policy.maxToolCalls !== undefined && (!Number.isSafeInteger(policy.maxToolCalls) || policy.maxToolCalls < 0))
		throw new CodeModeError({ code: "invalid-input", message: "maxToolCalls must be a non-negative integer" });
};
export const visibleTools = (tools: readonly CodeModeTool[], policy: CodeModePolicy = {}): readonly CodeModeTool[] =>
	tools.filter((tool) => toolAllowed(tool, policy));
export const effectAllowed = (effect: ToolEffect, policy: CodeModePolicy): boolean =>
	!policy.allowedEffects || policy.allowedEffects.includes(effect);
