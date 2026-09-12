import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentOsPiEnvironment, generateAgentOsPiPackage, minimalAgentOsExtensions } from "./agentos.ts";
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
test("package generation pins the runtime dependencies and protected environment", () => {
	const artifacts = generateAgentOsPiPackage({
		piCommand: "/opt/pi",
		extensionPath: "/opt/runtime.js",
		profileDir: "/profiles/worker",
		extraEnv: { PI_ACP_PI_COMMAND: "/evil", SAFE: "yes" },
	});
	const manifest = JSON.parse(artifacts.find((item) => item.path === "package.json")!.content) as {
		dependencies: Record<string, string>;
	};
	assert.equal(manifest.dependencies["pi-acp"], "0.80.6");
	const env = JSON.parse(artifacts.find((item) => item.path === "agentos-environment.json")!.content) as Record<
		string,
		string
	>;
	assert.equal(env.PI_ACP_PI_COMMAND, "/opt/pi");
	assert.equal(env.SAFE, "yes");
});
