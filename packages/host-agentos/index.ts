import { createRegistry, type CodeModeTool, type Registry } from "../core/index.ts";

export interface SandboxRequest {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
}
export interface SandboxResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly artifactId?: string;
}
export interface AgentOsBindings {
	readonly workspaceRead: (path: string, signal: AbortSignal) => Promise<string>;
	readonly workspaceWrite?: (path: string, content: string, signal: AbortSignal) => Promise<void>;
	readonly sandboxExec: (request: SandboxRequest, signal: AbortSignal) => Promise<SandboxResult>;
	readonly evidenceCreate?: (
		input: { name: string; content: string },
		signal: AbortSignal,
	) => Promise<{ artifactId: string }>;
	readonly webSearch?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
	readonly webFetch?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
export const createAgentOsRegistry = (bindings: AgentOsBindings): Registry => {
	const registry = createRegistry();
	const read: CodeModeTool = {
		id: "workspace.read",
		description: "Read a file from the session virtual workspace",
		inputSchema: schema({ path: { type: "string" } }, ["path"]),
		effect: "none",
		capabilities: ["workspace.read"],
		execute: async (input, context) => bindings.workspaceRead(String((input as { path: string }).path), context.signal),
	};
	registry.register(read);
	if (bindings.workspaceWrite)
		registry.register({
			id: "workspace.write",
			description: "Write a file in the session virtual workspace",
			inputSchema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
			effect: "workspace-write",
			capabilities: ["workspace.write"],
			execute: (input, context) =>
				bindings.workspaceWrite!(
					(input as { path: string }).path,
					(input as { content: string }).content,
					context.signal,
				),
		});
	registry.register({
		id: "sandbox.exec",
		description: "Run argv in a disposable external sandbox",
		inputSchema: schema(
			{
				argv: { type: "array", items: { type: "string" } },
				cwd: { type: "string" },
				timeoutMs: { type: "number" },
				env: { type: "object" },
			},
			["argv", "cwd"],
		),
		effect: "external",
		capabilities: ["sandbox.exec"],
		execute: (input, context) => {
			const request = input as SandboxRequest;
			if (request.argv.length === 0 || request.argv.some((arg) => arg.includes("\u0000")))
				throw new Error("sandbox argv must be non-empty and NUL-free");
			return bindings.sandboxExec(request, context.signal);
		},
	});
	if (bindings.evidenceCreate)
		registry.register({
			id: "evidence.create",
			description: "Store a bounded evidence artifact",
			inputSchema: schema({ name: { type: "string" }, content: { type: "string" } }, ["name", "content"]),
			effect: "workspace-write",
			capabilities: ["evidence.create"],
			execute: (input, context) =>
				bindings.evidenceCreate!(
					{ name: String((input as { name: string }).name), content: String((input as { content: string }).content) },
					context.signal,
				),
		});
	if (bindings.webSearch)
		registry.register({
			id: "web.search",
			description: "Search approved web sources",
			inputSchema: { type: "object" },
			effect: "none",
			capabilities: ["web.search"],
			execute: (input, context) => bindings.webSearch!(input, context.signal),
		});
	if (bindings.webFetch)
		registry.register({
			id: "web.fetch",
			description: "Fetch an approved web resource",
			inputSchema: { type: "object" },
			effect: "none",
			capabilities: ["web.fetch"],
			execute: (input, context) => bindings.webFetch!(input, context.signal),
		});
	return registry;
};
