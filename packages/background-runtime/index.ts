import { CodeModeExecutor, createRegistry, type CodeModeTool, type InvocationOptions } from "../core/index.ts";

export interface BackgroundRuntimeBinding {
	execute(input: InvocationOptions, signal: AbortSignal): Promise<unknown>;
}
export interface AgentOsPiExtensionApi {
	registerTool(tool: {
		name: "code_mode";
		description: string;
		inputSchema: Record<string, unknown>;
		execute: (input: InvocationOptions, signal: AbortSignal) => Promise<unknown>;
	}): void;
	readonly codeModeBinding?: BackgroundRuntimeBinding;
}
export const CODE_MODE_SCHEMA = {
	type: "object",
	properties: {
		code: { type: "string" },
		payloads: { type: "object" },
		limits: { type: "object" },
		policy: { type: "object" },
		invocationId: { type: "string" },
	},
	required: ["code"],
	additionalProperties: false,
} as const;
/** The sole AgentOS Pi extension. It adds no commands, widgets, or implicit tool discovery. */
export const registerBackgroundRuntime = (api: AgentOsPiExtensionApi): void => {
	api.registerTool({
		name: "code_mode",
		description: "Run typed orchestration against explicitly registered AgentOS capabilities",
		inputSchema: CODE_MODE_SCHEMA,
		execute: async (input, signal) => {
			if (!api.codeModeBinding)
				return new CodeModeExecutor({ registry: createRegistry() }).execute({ ...input, signal });
			return api.codeModeBinding.execute(input, signal);
		},
	});
};
export default registerBackgroundRuntime;
