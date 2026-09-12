import assert from "node:assert/strict";
import { test } from "node:test";
import { HostBridgeRuntime, QuickJsRuntime } from "./index.ts";
import { QuickJsRuntime as StandaloneRuntime } from "./quickjs-runtime-simple.ts";

const options = {
	timeoutMs: 1_000,
	memoryLimitBytes: 64 * 1024 * 1024,
	setup: "delete globalThis.__spindleHostCall;",
	polyfills: false,
};

test("public standalone runtime contract is preserved", () => {
	assert.equal(QuickJsRuntime, StandaloneRuntime);
});

test("core host bridge installs no implicit Pi or extension capabilities", async () => {
	const result = await new HostBridgeRuntime().execute(
		'return ["pi", "mcp", "agents", "web", "extensions"].map(key => typeof globalThis[key]);',
		async () => {
			throw new Error("unexpected host call");
		},
		options,
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, Array(5).fill("undefined"));
});

test("trusted host bootstrap explicitly binds a capability", async () => {
	const result = await new HostBridgeRuntime().execute(
		"return await reports.list({limit: 2});",
		async (ref, args) => ({ ref, args }),
		{
			...options,
			setup:
				'(() => { const call = globalThis.__spindleHostCall; delete globalThis.__spindleHostCall; globalThis.reports = { list: args => call("reports.list", args) }; })();',
		},
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, { ref: "reports.list", args: { limit: 2 } });
});

test("host bridge preserves cancellation and deadline termination", async () => {
	const runtime = new HostBridgeRuntime();
	const cancelled = await runtime.execute("return 1;", async () => null, { ...options, signal: AbortSignal.abort() });
	assert.equal(cancelled.terminationReason, "aborted");
	const timedOut = await runtime.execute("while (true) {}", async () => null, { ...options, timeoutMs: 20 });
	assert.equal(timedOut.terminationReason, "timed_out");
});
