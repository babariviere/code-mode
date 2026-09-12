import {
	QuickJsRuntime,
	type SpindleSandboxOptions,
	type SpindleHostCall,
	type SpindleSandboxResult,
} from "../core/quickjs-runtime.ts";
import { GUEST_SETUP } from "./guest-setup.ts";

export { GUEST_SETUP } from "./guest-setup.ts";
export type {
	SpindleHostCall,
	SpindleSandboxResult,
	SpindleSandboxTerminationReason,
} from "../core/quickjs-runtime.ts";

/** Interactive host configuration. None of these bindings are model-controlled. */
export interface PiSandboxOptions
	extends Omit<SpindleSandboxOptions, "setup" | "bindings" | "hostErrorMetadataProperty"> {
	/** The Pi host filters the environment before supplying this snapshot. */
	process?: { env: Record<string, string>; platform: string; arch: string; cwd: string };
	providers?: readonly string[];
}

/** Pi API compatibility on top of the runtime-independent host bridge. */
export class PiQuickJsRuntime extends QuickJsRuntime {
	async execute(code: string, hostCall: SpindleHostCall, options: PiSandboxOptions): Promise<SpindleSandboxResult> {
		return super.execute(code, hostCall, {
			...options,
			setup: GUEST_SETUP,
			bindings: {
				__spindleProcess: options.process ?? { env: {}, platform: "unknown", arch: "unknown", cwd: "" },
				__spindleProviders: options.providers ?? [],
			},
			hostErrorMetadataProperty: "__spindleBashExit",
		});
	}
}
