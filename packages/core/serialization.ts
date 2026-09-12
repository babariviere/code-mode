import { CodeModeError } from "./contracts.ts";

/** Serializes JSON-compatible values while checking the bound before constructing the final string. */
export const serializeBounded = (value: unknown, maxChars: number, label = "value"): string => {
	const seen = new Set<object>();
	const append = (text: string): string => {
		if (text.length > maxChars)
			throw new CodeModeError({ code: "result-too-large", message: `${label} exceeds ${maxChars} characters` });
		return text;
	};
	const join = (open: string, parts: readonly string[], close: string): string => {
		const total =
			open.length + close.length + parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);
		if (total > maxChars)
			throw new CodeModeError({ code: "result-too-large", message: `${label} exceeds ${maxChars} characters` });
		return `${open}${parts.join(",")}${close}`;
	};
	const encode = (current: unknown): string => {
		if (current === undefined || current === null) return append("null");
		if (typeof current === "string") return append(JSON.stringify(current));
		if (typeof current === "boolean") return append(String(current));
		if (typeof current === "number" && Number.isFinite(current)) return append(String(current));
		if (typeof current !== "object")
			throw new CodeModeError({ code: "invalid-input", message: `${label} contains a non-JSON value` });
		if (seen.has(current)) throw new CodeModeError({ code: "invalid-input", message: `${label} contains a cycle` });
		seen.add(current);
		let result: string;
		if (Array.isArray(current)) {
			const parts: string[] = [];
			for (const item of current) {
				parts.push(encode(item));
				if (parts.reduce((sum, part) => sum + part.length, 0) + parts.length + 2 > maxChars)
					return join("[", parts, "]");
			}
			result = join("[", parts, "]");
		} else {
			const parts: string[] = [];
			for (const key in current) {
				if (!Object.hasOwn(current, key)) continue;
				parts.push(`${JSON.stringify(key)}:${encode((current as Record<string, unknown>)[key])}`);
				if (parts.reduce((sum, part) => sum + part.length, 0) + parts.length + 2 > maxChars)
					return join("{", parts, "}");
			}
			result = join("{", parts, "}");
		}
		seen.delete(current);
		return append(result);
	};
	return encode(value);
};
