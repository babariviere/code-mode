import { test } from "node:test";
import assert from "node:assert/strict";
import { registerBackgroundRuntime, CODE_MODE_SCHEMA } from "./index.ts";

test("background runtime omits model policy and applies host role policy", async () => {
	let registered:
		| { inputSchema: typeof CODE_MODE_SCHEMA; execute: (input: any, signal: AbortSignal) => Promise<unknown> }
		| undefined;
	registerBackgroundRuntime({
		rolePolicy: { allowedTools: ["workspace.read"] },
		registerTool: (tool) => {
			registered = tool as unknown as typeof registered;
		},
	});
	assert.ok(registered);
	assert.equal("policy" in CODE_MODE_SCHEMA.properties, false);
	const result = await registered!.execute(
		{ code: "return 1;", policy: { allowedTools: ["*"], allowedEffects: ["external"] } },
		new AbortController().signal,
	);
	assert.equal((result as { ok: boolean }).ok, true);
});
test("background bindings receive a frozen host policy, never model policy", async () => {
	let observed: any;
	let registered: any;
	const hostPolicy = { allowedTools: ["workspace.read"] };
	registerBackgroundRuntime({
		rolePolicy: hostPolicy,
		registerTool: (tool) => {
			registered = tool;
		},
		codeModeBinding: {
			execute: async (_input, _signal, policy) => {
				observed = policy;
				return { ok: true };
			},
		},
	});
	hostPolicy.allowedTools.push("sandbox.exec");
	await registered.execute(
		{ code: "return 1;", policy: { allowedTools: ["sandbox.exec"] } },
		new AbortController().signal,
	);
	assert.equal(Object.isFrozen(observed), true);
	assert.deepEqual(observed.allowedTools, ["workspace.read"]);
});
