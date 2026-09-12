import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiRegistry } from "./index.ts";
import { createAgentOsRegistry } from "../host-agentos/index.ts";
test("Pi adapter requires explicit tools", () => {
	const registry = createPiRegistry({
		coreTools: [{ name: "read", description: "read", inputSchema: { type: "object" }, execute: () => "ok" }],
	});
	assert.deepEqual(
		registry.discover().map((tool) => tool.id),
		["pi.read"],
	);
});
test("AgentOS adapter does not expose process or filesystem primitives", () => {
	const registry = createAgentOsRegistry({
		workspaceRead: async () => "ok",
		sandboxExec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
	});
	assert.deepEqual(
		registry.discover().map((tool) => tool.id),
		["workspace.read", "sandbox.exec"],
	);
});
