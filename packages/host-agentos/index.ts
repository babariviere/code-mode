import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
export interface AgentOsSecurityOptions {
	readonly workspaceRoot?: string;
	readonly maxPathChars?: number;
	readonly maxWorkspaceContentChars?: number;
	readonly maxSandboxTimeoutMs?: number;
	readonly maxArgChars?: number;
	readonly maxOutputChars?: number;
	readonly maxEvidenceChars?: number;
	readonly allowedEnv?: readonly string[];
}
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const credentialName = (name: string): boolean =>
	/(TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|AWS_)/i.test(name);

export const createAgentOsRegistry = (bindings: AgentOsBindings, options: AgentOsSecurityOptions = {}): Registry => {
	const registry = createRegistry();
	const root = resolve(options.workspaceRoot ?? "/workspace");
	const maxPathChars = options.maxPathChars ?? 4_096;
	const maxWorkspaceContentChars = options.maxWorkspaceContentChars ?? 512_000;
	const maxSandboxTimeoutMs = options.maxSandboxTimeoutMs ?? 120_000;
	const maxArgChars = options.maxArgChars ?? 16_384;
	const maxOutputChars = options.maxOutputChars ?? 512_000;
	const maxEvidenceChars = options.maxEvidenceChars ?? 512_000;
	const allowedEnv = new Set(options.allowedEnv ?? []);
	const isWithinRoot = (workspaceRoot: string, path: string): boolean => {
		const distance = relative(workspaceRoot, path);
		return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
	};
	const realpathOrExistingAncestor = async (path: string): Promise<string> => {
		let candidate = path;
		while (true) {
			try {
				return await realpath(candidate);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = resolve(candidate, "..");
				if (parent === candidate) throw error;
				candidate = parent;
			}
		}
	};
	const confinedWorkspacePath = async (value: string): Promise<string> => {
		const path = workspacePath(value);
		try {
			const realRoot = await realpath(root);
			let current = path;
			while (current !== root && isWithinRoot(root, current)) {
				let stats;
				try {
					stats = await lstat(current);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					current = resolve(current, "..");
					continue;
				}
				if (stats.isSymbolicLink()) {
					let realPath: string;
					try {
						realPath = await realpath(current);
					} catch {
						throw new Error("path escapes workspace");
					}
					if (!isWithinRoot(realRoot, realPath)) throw new Error("path escapes workspace");
				}
				current = resolve(current, "..");
			}
			const realPath = await realpathOrExistingAncestor(path);
			if (!isWithinRoot(realRoot, realPath)) throw new Error("path escapes workspace");
			return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
			throw error instanceof Error && error.message === "path escapes workspace"
				? error
				: new Error("path is not safely confined to workspace");
		}
	};
	const workspacePath = (value: string): string => {
		if (value.length > maxPathChars || value.includes("\0")) throw new Error("invalid workspace path");
		const path = resolve(root, value);
		if (
			path !== root &&
			relative(root, path)
				.split("/")
				.some((part) => part === "..")
		)
			throw new Error("path escapes workspace");
		return path;
	};
	const boundedText = (value: string, max: number, label: string): string => {
		if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
		return value;
	};
	const boundedEnv = (
		env: Readonly<Record<string, string>> | undefined,
	): Readonly<Record<string, string>> | undefined => {
		if (!env) return undefined;
		for (const [name, value] of Object.entries(env)) {
			if (!allowedEnv.has(name) || credentialName(name) || value.includes("\0"))
				throw new Error(`environment variable is not allowed: ${name}`);
		}
		return env;
	};
	registry.register({
		id: "workspace.read",
		description: "Read a file from the session virtual workspace",
		inputSchema: schema({ path: { type: "string" } }, ["path"]),
		effect: "none",
		capabilities: ["workspace.read"],
		execute: async (input, context) =>
			boundedText(
				await bindings.workspaceRead(await confinedWorkspacePath((input as { path: string }).path), context.signal),
				maxWorkspaceContentChars,
				"workspace content",
			),
	} satisfies CodeModeTool);
	if (bindings.workspaceWrite)
		registry.register({
			id: "workspace.write",
			description: "Write a file in the session virtual workspace",
			inputSchema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
			effect: "workspace-write",
			capabilities: ["workspace.write"],
			execute: (input, context) => {
				const request = input as { path: string; content: string };
				return confinedWorkspacePath(request.path).then((path) =>
					bindings.workspaceWrite!(
						path,
						boundedText(request.content, maxWorkspaceContentChars, "workspace content"),
						context.signal,
					),
				);
			},
		});
	registry.register({
		id: "sandbox.exec",
		description: "Run argv in a disposable external sandbox",
		inputSchema: schema(
			{
				argv: { type: "array", items: { type: "string" } },
				cwd: { type: "string" },
				timeoutMs: { type: "integer" },
				env: { type: "object" },
			},
			["argv", "cwd"],
		),
		effect: "external",
		capabilities: ["sandbox.exec"],
		execute: (input, context) => {
			const request = input as SandboxRequest;
			if (
				request.argv.length === 0 ||
				request.argv.length > 128 ||
				request.argv.some((arg) => arg.includes("\0") || arg.length > maxArgChars)
			)
				throw new Error("sandbox argv is invalid");
			const cwd = confinedWorkspacePath(request.cwd);
			const timeoutMs = request.timeoutMs ?? maxSandboxTimeoutMs;
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxSandboxTimeoutMs)
				throw new Error("sandbox timeout exceeds policy");
			const env = boundedEnv(request.env);
			return cwd
				.then((safeCwd) =>
					bindings.sandboxExec(
						{ argv: [...request.argv], cwd: safeCwd, timeoutMs, ...(env ? { env } : {}) },
						context.signal,
					),
				)
				.then((result) => ({
					...result,
					stdout: boundedText(result.stdout, maxOutputChars, "sandbox stdout"),
					stderr: boundedText(result.stderr, maxOutputChars, "sandbox stderr"),
				}));
		},
	});
	if (bindings.evidenceCreate)
		registry.register({
			id: "evidence.create",
			description: "Store a bounded evidence artifact",
			inputSchema: schema({ name: { type: "string" }, content: { type: "string" } }, ["name", "content"]),
			effect: "workspace-write",
			capabilities: ["evidence.create"],
			execute: (input, context) => {
				const value = input as { name: string; content: string };
				return bindings.evidenceCreate!(
					{
						name: boundedText(value.name, 256, "evidence name"),
						content: boundedText(value.content, maxEvidenceChars, "evidence content"),
					},
					context.signal,
				);
			},
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
