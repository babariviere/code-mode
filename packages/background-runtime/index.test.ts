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
