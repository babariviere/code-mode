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
	maxDiscoveryCalls: 16,
	maxCodeChars: 256_000,
	maxPayloadBytes: 512_000,
	maxDeclarationChars: 512_000,
	maxToolInputBytes: 128_000,
	maxToolOutputChars: 512_000,
	maxOutputChars: 100_000,
	maxLogChars: 20_000,
	memoryLimitBytes: 64 * 1024 * 1024,
	maxStateBytes: 64 * 1024,
});
const HARD_LIMITS: Record<keyof InvocationLimits, number> = {
	timeoutMs: 10 * 60_000,
	maxToolCalls: 1_024,
	maxDiscoveryCalls: 256,
	maxCodeChars: 4 * 1024 * 1024,
	maxPayloadBytes: 8 * 1024 * 1024,
	maxDeclarationChars: 8 * 1024 * 1024,
	maxToolInputBytes: 2 * 1024 * 1024,
	maxToolOutputChars: 8 * 1024 * 1024,
	maxOutputChars: 8 * 1024 * 1024,
	maxLogChars: 1 * 1024 * 1024,
	memoryLimitBytes: 512 * 1024 * 1024,
	maxStateBytes: 4 * 1024 * 1024,
};
export const mergeLimits = (limits: Partial<InvocationLimits> = {}): InvocationLimits => {
	const merged = { ...DEFAULT_LIMITS, ...limits };
	for (const [key, value] of Object.entries(merged))
		if (!Number.isSafeInteger(value) || value < (key === "maxToolCalls" || key === "maxDiscoveryCalls" ? 0 : 1))
			throw new CodeModeError({ code: "invalid-input", message: `Invalid limit ${key}: ${value}` });
		else if (value > HARD_LIMITS[key as keyof InvocationLimits])
			throw new CodeModeError({ code: "invalid-input", message: `Limit ${key} exceeds host maximum` });
	return merged;
};
export const assertPolicy = (policy: CodeModePolicy): void => {
	if (policy.maxToolCalls !== undefined && (!Number.isSafeInteger(policy.maxToolCalls) || policy.maxToolCalls < 0))
		throw new CodeModeError({ code: "invalid-input", message: "maxToolCalls must be a non-negative integer" });
};
export const restrictPolicy = (host: CodeModePolicy, requested: CodeModePolicy = {}): CodeModePolicy => {
	const allowedTools =
		host.allowedTools && requested.allowedTools
			? host.allowedTools.filter((pattern) => requested.allowedTools!.includes(pattern))
			: (host.allowedTools ?? requested.allowedTools);
	const allowedCapabilities =
		host.allowedCapabilities && requested.allowedCapabilities
			? host.allowedCapabilities.filter((capability) => requested.allowedCapabilities!.includes(capability))
			: (host.allowedCapabilities ?? requested.allowedCapabilities);
	const allowedEffects =
		host.allowedEffects && requested.allowedEffects
			? host.allowedEffects.filter((effect) => requested.allowedEffects!.includes(effect))
			: (host.allowedEffects ?? requested.allowedEffects);
	return {
		...(allowedTools ? { allowedTools } : {}),
		...(allowedCapabilities ? { allowedCapabilities } : {}),
		...(allowedEffects ? { allowedEffects } : {}),
		deniedTools: [...(host.deniedTools ?? []), ...(requested.deniedTools ?? [])],
		maxToolCalls: Math.min(
			host.maxToolCalls ?? Number.MAX_SAFE_INTEGER,
			requested.maxToolCalls ?? Number.MAX_SAFE_INTEGER,
		),
	};
};
export const immutablePolicy = (policy: CodeModePolicy): CodeModePolicy =>
	Object.freeze({
		...policy,
		...(policy.allowedTools ? { allowedTools: Object.freeze([...policy.allowedTools]) } : {}),
		...(policy.allowedCapabilities ? { allowedCapabilities: Object.freeze([...policy.allowedCapabilities]) } : {}),
		...(policy.deniedTools ? { deniedTools: Object.freeze([...policy.deniedTools]) } : {}),
		...(policy.allowedEffects ? { allowedEffects: Object.freeze([...policy.allowedEffects]) } : {}),
	});
export const visibleTools = (tools: readonly CodeModeTool[], policy: CodeModePolicy = {}): readonly CodeModeTool[] =>
	tools.filter((tool) => toolAllowed(tool, policy));
export const effectAllowed = (effect: ToolEffect, policy: CodeModePolicy): boolean =>
	!policy.allowedEffects || policy.allowedEffects.includes(effect);
