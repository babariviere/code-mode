import {
	CodeModeError,
	type CodeModePolicy,
	type CodeModeTool,
	type JsonSchema,
	type ToolSummary,
} from "./contracts.ts";

const TOOL_ID = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/;
const CAPABILITY = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_.-]*)*$/;
const RESERVED = new Set(["tools.search"]);

export interface ToolRegistry {
	register<TInput, TOutput>(tool: CodeModeTool<TInput, TOutput>): void;
	registerMany(tools: readonly CodeModeTool[]): void;
	get(id: string): CodeModeTool | undefined;
	discover(query?: string, policy?: CodeModePolicy): readonly ToolSummary[];
	declarations(policy?: CodeModePolicy): string;
	declarationBindings(policy?: CodeModePolicy): readonly { namespace: string; name: string; id: string }[];
	invoke(
		id: string,
		input: unknown,
		context: Parameters<CodeModeTool["execute"]>[1],
		policy?: CodeModePolicy,
	): Promise<unknown>;
}

const matches = (pattern: string, value: string): boolean => {
	if (pattern.endsWith(".*")) return value.startsWith(pattern.slice(0, -1));
	return pattern === value;
};

export const validateSchema = (schema: JsonSchema, value: unknown, path = "input"): void => {
	if (schema.type === "string" && typeof value !== "string")
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be a string` });
	if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be a number` });
	if (schema.type === "integer" && (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)))
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be an integer` });
	if (schema.type === "null" && value !== null)
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be null` });
	if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be an allowed value` });
	if (schema.type === "boolean" && typeof value !== "boolean")
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be a boolean` });
	if (schema.type === "array") {
		if (!Array.isArray(value)) throw new CodeModeError({ code: "invalid-input", message: `${path} must be an array` });
		if (schema.items)
			for (const [index, item] of value.entries()) validateSchema(schema.items, item, `${path}[${index}]`);
	}
	if (
		(schema.type === "object" || schema.properties) &&
		(typeof value !== "object" || value === null || Array.isArray(value))
	)
		throw new CodeModeError({ code: "invalid-input", message: `${path} must be an object` });
	if (schema.type === "object" || schema.properties) {
		const record = value as Record<string, unknown>;
		for (const required of schema.required ?? [])
			if (!(required in record))
				throw new CodeModeError({ code: "invalid-input", message: `${path}.${required} is required` });
		for (const [key, child] of Object.entries(schema.properties ?? {}))
			if (key in record) validateSchema(child, record[key], `${path}.${key}`);
		if (schema.additionalProperties === false)
			for (const key of Object.keys(record))
				if (!(key in (schema.properties ?? {})))
					throw new CodeModeError({ code: "invalid-input", message: `${path}.${key} is not allowed` });
	}
};

export const toolAllowed = (tool: CodeModeTool, policy: CodeModePolicy = {}): boolean => {
	if (policy.deniedTools?.some((pattern) => matches(pattern, tool.id))) return false;
	if (policy.allowedTools && !policy.allowedTools.some((pattern) => matches(pattern, tool.id))) return false;
	if (policy.allowedEffects && !policy.allowedEffects.includes(tool.effect)) return false;
	if (
		policy.allowedCapabilities &&
		(!tool.capabilities?.length || !tool.capabilities.every((cap) => policy.allowedCapabilities!.includes(cap)))
	)
		return false;
	return true;
};

const schemaType = (schema: JsonSchema | undefined, aliases: Map<string, string>, hint: string): string => {
	if (!schema) return "unknown";
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "unknown";
	if (schema.type === "string") return "string";
	if (schema.type === "number" || schema.type === "integer") return "number";
	if (schema.type === "boolean") return "boolean";
	if (schema.type === "null") return "null";
	if (schema.type === "array") return `${schemaType(schema.items, aliases, `${hint}Item`)}[]`;
	if (schema.type === "object" || schema.properties) {
		const name = hint.replace(/[^A-Za-z0-9_$]/g, "") || "ToolInput";
		if (!aliases.has(name)) {
			const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
				const optional = schema.required?.includes(key) ? "" : "?";
				return `\t${JSON.stringify(key)}${optional}: ${schemaType(value, aliases, `${name}${key}`)};`;
			});
			const additional = schema.additionalProperties === false ? "" : "\n\t[key: string]: unknown;";
			aliases.set(name, `{\n${fields.join("\n")}${additional}\n}`);
		}
		return name;
	}
	return "unknown";
};

export const generateDeclarations = (tools: readonly CodeModeTool[], policy: CodeModePolicy = {}): string => {
	const visible = tools.filter((tool) => toolAllowed(tool, policy));
	const aliases = new Map<string, string>();
	const namespaces = new Map<string, string[]>();
	for (const tool of visible) {
		const [namespace, ...parts] = tool.id.split(".");
		if (!namespace || parts.length === 0) continue;
		const functionName = parts.join("_").replace(/[^A-Za-z0-9_$]/g, "_");
		const existing = namespaces.get(namespace) ?? [];
		if (existing.some((line) => line.startsWith(`\tfunction ${functionName}(`)))
			throw new CodeModeError({
				code: "invalid-input",
				message: `Tool declaration collision: ${namespace}.${functionName}`,
			});
		const input = schemaType(tool.inputSchema, aliases, `${namespace}${functionName}Input`);
		const output = schemaType(tool.outputSchema, aliases, `${namespace}${functionName}Output`);
		const lines = namespaces.get(namespace) ?? [];
		lines.push(`\tfunction ${functionName}(input: ${input}): Promise<${output}>;`);
		namespaces.set(namespace, lines);
	}
	const types = [...aliases.entries()].map(([name, value]) => `type ${name} = ${value};`).join("\n\n");
	const ns = [...namespaces.entries()]
		.map(([name, lines]) => `declare namespace ${name} {\n${lines.join("\n")}\n}`)
		.join("\n\n");
	return `${types}${types && ns ? "\n\n" : ""}${ns}\n\ndeclare const π: Readonly<Record<string, unknown>>;\ndeclare const τ: Record<string, unknown>;\ndeclare function print(...values: unknown[]): void;\n\ndeclare namespace tools {\n\tfunction search(input?: { query?: string }): Promise<ToolSummary[]>;\n}\n\ninterface ToolSummary { id: string; description: string; effect: "none" | "workspace-write" | "external"; capabilities: string[]; inputSchema: unknown; outputSchema?: unknown; }`;
};

export class Registry implements ToolRegistry {
	readonly #tools = new Map<string, CodeModeTool>();
	register<TInput, TOutput>(tool: CodeModeTool<TInput, TOutput>): void {
		if (!TOOL_ID.test(tool.id) || RESERVED.has(tool.id))
			throw new CodeModeError({
				code: "invalid-input",
				message: `Invalid or reserved tool id: ${tool.id}`,
				toolId: tool.id,
			});
		for (const capability of tool.capabilities ?? []) {
			if (!CAPABILITY.test(capability))
				throw new CodeModeError({
					code: "invalid-input",
					message: `Invalid capability: ${capability}`,
					toolId: tool.id,
				});
		}
		if (this.#tools.has(tool.id))
			throw new CodeModeError({
				code: "invalid-input",
				message: `Tool already registered: ${tool.id}`,
				toolId: tool.id,
			});
		this.#tools.set(tool.id, tool as CodeModeTool);
	}
	registerMany(tools: readonly CodeModeTool[]): void {
		for (const tool of tools) this.register(tool);
	}
	get(id: string): CodeModeTool | undefined {
		return this.#tools.get(id);
	}
	discover(query = "", policy: CodeModePolicy = {}): readonly ToolSummary[] {
		const normalized = query.trim().toLowerCase();
		return [...this.#tools.values()]
			.filter(
				(tool) =>
					toolAllowed(tool, policy) &&
					(!normalized || tool.id.includes(normalized) || tool.description.toLowerCase().includes(normalized)),
			)
			.map((tool) => ({
				id: tool.id,
				description: tool.description,
				effect: tool.effect,
				capabilities: [...(tool.capabilities ?? [])],
				inputSchema: tool.inputSchema,
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
			}));
	}
	declarations(policy?: CodeModePolicy): string {
		return generateDeclarations([...this.#tools.values()], policy);
	}
	declarationBindings(policy: CodeModePolicy = {}): readonly { namespace: string; name: string; id: string }[] {
		return [...this.#tools.values()]
			.filter((tool) => toolAllowed(tool, policy))
			.map((tool) => {
				const [namespace, ...parts] = tool.id.split(".");
				return { namespace: namespace!, name: parts.join("_").replace(/[^A-Za-z0-9_$]/g, "_"), id: tool.id };
			});
	}
	async invoke(
		id: string,
		input: unknown,
		context: Parameters<CodeModeTool["execute"]>[1],
		policy: CodeModePolicy = {},
	): Promise<unknown> {
		const tool = this.#tools.get(id);
		if (!tool)
			throw new CodeModeError({ code: "tool-not-found", message: `Tool is not registered: ${id}`, toolId: id });
		if (!toolAllowed(tool, policy))
			throw new CodeModeError({ code: "policy-denied", message: `Policy denied tool: ${id}`, toolId: id });
		try {
			validateSchema(tool.inputSchema, input);
			const output = await tool.execute(input, context);
			if (tool.outputSchema) validateSchema(tool.outputSchema, output, "output");
			return output;
		} catch (error) {
			if (error instanceof CodeModeError) throw error;
			throw new CodeModeError({
				code: "tool-error",
				message: `Tool failed: ${id}`,
				toolId: id,
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export const createRegistry = (tools: readonly CodeModeTool[] = []): Registry => {
	const registry = new Registry();
	registry.registerMany(tools);
	return registry;
};
