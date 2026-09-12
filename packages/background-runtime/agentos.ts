export const AGENTOS_PI_VERSION = "0.80.6" as const;
export interface AgentOsPiPackageOptions {
	readonly piCommand: string;
	readonly extensionPath: string;
	readonly profileDir: string;
	readonly extraEnv?: Readonly<Record<string, string>>;
}
/** Builds the isolated ACP environment. The caller must provide a separately provisioned profile. */
export const createAgentOsPiEnvironment = (options: AgentOsPiPackageOptions): Readonly<Record<string, string>> => ({
	PI_ACP_PI_COMMAND: options.piCommand,
	PI_CODING_AGENT_DIR: options.profileDir,
	PI_ACP_EXTENSIONS: options.extensionPath,
	...(options.extraEnv ?? {}),
});
export const minimalAgentOsExtensions = (extensionPath: string): readonly string[] => [extensionPath];
