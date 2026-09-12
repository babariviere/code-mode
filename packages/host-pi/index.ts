import { createRegistry, type CodeModeTool, type Registry } from "../core/index.ts";

export interface PiTool<TInput = unknown, TOutput = unknown> {
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
		const id = `pi.${tool.name}` as `${string}.${string}`;
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
				new CodeModeExecutor({ registry })
					.execute(input as never)
					.then((result) => ({ ...result, invocationId: context.invocationId })),
			),
	};
};
