import { createRegistry, type CodeModeTool, type Registry, type ToolId } from "../core/index.ts";
export * from "./interactive-runtime.ts";

export interface PiTool<TInput = unknown, TOutput = unknown> {
	/** Explicit capability ID for selected tools, for example web.search. */
	readonly id?: ToolId;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput> | TOutput;
	readonly effect?: "none" | "workspace-write" | "external";
	readonly capabilities?: readonly string[];
}
export interface PiHostOptions {
	readonly coreTools?: readonly PiTool[];
	readonly selectedTools?: readonly PiTool[];
}
/** Registers only the tools supplied by the trusted host. Nothing is discovered implicitly. */
export const createPiRegistry = (options: PiHostOptions = {}): Registry => {
	const registry = createRegistry();
	for (const tool of [...(options.coreTools ?? []), ...(options.selectedTools ?? [])]) {
		const id = tool.id ?? (`pi.${tool.name}` as ToolId);
		registry.register({
			id,
			description: tool.description,
			inputSchema: tool.inputSchema,
			effect: tool.effect ?? "none",
			...(tool.capabilities ? { capabilities: tool.capabilities } : {}),
			execute: (input, context) => tool.execute(input, context.signal),
		} satisfies CodeModeTool);
	}
	return registry;
};
export interface PiCodeModeHost {
	readonly registry: Registry;
	readonly execute: CodeModeTool["execute"];
}
export const createPiCodeModeHost = (options: PiHostOptions = {}): PiCodeModeHost => {
	const registry = createPiRegistry(options);
	return {
		registry,
		execute: (input, context) =>
			import("../core/executor.ts").then(({ CodeModeExecutor }) =>
				new CodeModeExecutor({ registry, onProgress: context.reportProgress })
					.execute({ ...(input as object), signal: context.signal, invocationId: context.invocationId } as never)
					.then((result) => ({ ...result, invocationId: context.invocationId })),
			),
	};
};
