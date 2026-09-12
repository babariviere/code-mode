export const AGENTOS_PI_VERSION = "0.80.6" as const;
export interface AgentOsPiPackageOptions {
	readonly piCommand: string;
	readonly extensionPath: string;
	readonly profileDir: string;
	readonly extraEnv?: Readonly<Record<string, string>>;
}
/** Builds the isolated ACP environment. The caller must provide a separately provisioned profile. */
export const createAgentOsPiEnvironment = (options: AgentOsPiPackageOptions): Readonly<Record<string, string>> =>
	Object.freeze({
		...(options.extraEnv ?? {}),
		PI_ACP_PI_COMMAND: options.piCommand,
		PI_CODING_AGENT_DIR: options.profileDir,
		PI_ACP_EXTENSIONS: options.extensionPath,
	});
export const minimalAgentOsExtensions = (extensionPath: string): readonly string[] => [extensionPath];

export interface AgentOsPackageArtifact {
	readonly path: string;
	readonly content: string;
}
/**
 * Produces the small, reviewable package manifest consumed by an AgentOS image build.
 * The image builder copies the emitted background-runtime JavaScript beside this manifest.
 */
export const generateAgentOsPiPackage = (options: AgentOsPiPackageOptions): readonly AgentOsPackageArtifact[] => [
	{
		path: "package.json",
		content:
			JSON.stringify(
				{
					name: "code-mode-agentos-pi",
					private: true,
					type: "module",
					dependencies: {
						"@earendil-works/pi-coding-agent": AGENTOS_PI_VERSION,
						"pi-acp": AGENTOS_PI_VERSION,
					},
				},
				null,
				2,
			) + "\n",
	},
	{
		path: "agentos-environment.json",
		content: JSON.stringify(createAgentOsPiEnvironment(options), null, 2) + "\n",
	},
];
