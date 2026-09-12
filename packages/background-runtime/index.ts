import {
	CodeModeExecutor,
	createRegistry,
	immutablePolicy,
	type CodeModePolicy,
	type CodeModeTool,
	type InvocationOptions,
} from "../core/index.ts";

export interface BackgroundRuntimeBinding {
	execute(input: Omit<InvocationOptions, "policy">, signal: AbortSignal, rolePolicy?: CodeModePolicy): Promise<unknown>;
}
export interface AgentOsPiExtensionApi {
	registerTool(tool: {
		name: "code_mode";
		description: string;
		inputSchema: Record<string, unknown>;
		execute: (input: InvocationOptions, signal: AbortSignal) => Promise<unknown>;
	}): void;
	readonly codeModeBinding?: BackgroundRuntimeBinding;
	/** Supplied by the trusted role host. It is never accepted from model input. */
	readonly rolePolicy?: CodeModePolicy;
}
export const CODE_MODE_SCHEMA = {
	type: "object",
	properties: {
		code: { type: "string" },
		payloads: { type: "object" },
		limits: { type: "object" },
		invocationId: { type: "string" },
	},
	required: ["code"],
	additionalProperties: false,
} as const;
/** The sole AgentOS Pi extension. It adds no commands, widgets, or implicit tool discovery. */
export const registerBackgroundRuntime = (api: AgentOsPiExtensionApi): void => {
	const rolePolicy = api.rolePolicy ? immutablePolicy(api.rolePolicy) : undefined;
	api.registerTool({
		name: "code_mode",
		description: "Run typed orchestration against explicitly registered AgentOS capabilities",
		inputSchema: CODE_MODE_SCHEMA,
		execute: async (input, signal) => {
			const { policy: _untrustedPolicy, ...untrustedInput } = input;
			if (!api.codeModeBinding)
				return new CodeModeExecutor({
					registry: createRegistry(),
					...(rolePolicy ? { policy: rolePolicy } : {}),
				}).execute({ ...untrustedInput, signal });
			return api.codeModeBinding.execute(untrustedInput, signal, rolePolicy);
		},
	});
};
export default registerBackgroundRuntime;
