import type { CodeModeErrorShape } from "./contracts.ts";

export const formatResult = (value: unknown, format: "auto" | "yaml" | "json" | "text" = "auto"): string => {
	if (format === "text" || (format === "auto" && typeof value === "string")) return String(value ?? "");
	if (format === "yaml") return toYaml(value);
	return JSON.stringify(value === undefined ? null : value);
};
export const formatError = (error: CodeModeErrorShape): string => JSON.stringify(error);
const toYaml = (value: unknown, indent = ""): string => {
	if (value === null || typeof value !== "object") return `${indent}${String(value)}\n`;
	if (Array.isArray(value))
		return (
			value
				.map(
					(item) =>
						`${indent}- ${typeof item === "object" && item !== null ? `\n${toYaml(item, indent + "  ")}` : String(item)}`,
				)
				.join("\n") + "\n"
		);
	return (
		Object.entries(value as Record<string, unknown>)
			.map(
				([key, item]) =>
					`${indent}${key}: ${typeof item === "object" && item !== null ? `\n${toYaml(item, indent + "  ")}` : String(item)}`,
			)
			.join("\n") + "\n"
	);
};
