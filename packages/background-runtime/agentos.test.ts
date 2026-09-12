import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentOsPiEnvironment, minimalAgentOsExtensions } from "./agentos.ts";
test("AgentOS package environment pins command and isolated profile", () => {
	const env = createAgentOsPiEnvironment({
		piCommand: "/opt/pi",
		extensionPath: "/opt/background-runtime.ts",
		profileDir: "/var/lib/pi/profile",
	});
	assert.equal(env.PI_ACP_PI_COMMAND, "/opt/pi");
	assert.equal(env.PI_CODING_AGENT_DIR, "/var/lib/pi/profile");
	assert.deepEqual(minimalAgentOsExtensions("/opt/background-runtime.ts"), ["/opt/background-runtime.ts"]);
});
