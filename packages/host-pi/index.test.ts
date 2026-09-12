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
test("AgentOS adapter enforces workspace, timeout, environment, and output bounds", async () => {
	let received: unknown;
	const registry = createAgentOsRegistry(
		{
			workspaceRead: async () => "ok",
			sandboxExec: async (request) => {
				received = request;
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
			},
		},
		{ allowedEnv: ["LANG"], maxSandboxTimeoutMs: 10 },
	);
	const context = {
		signal: new AbortController().signal,
		invocationId: "i",
		reportProgress: () => {},
		state: {},
	} as never;
	await assert.rejects(
		() => registry.invoke("sandbox.exec", { argv: ["echo", "ok"], cwd: "/workspace/../private" }, context),
		(error: any) => error.cause === "path escapes workspace",
	);
	await assert.rejects(
		() => registry.invoke("sandbox.exec", { argv: ["echo"], cwd: "/workspace", timeoutMs: 11 }, context),
		(error: any) => error.cause === "sandbox timeout exceeds policy",
	);
	await assert.rejects(
		() => registry.invoke("sandbox.exec", { argv: ["echo"], cwd: "/workspace", env: { HOME: "/tmp" } }, context),
		(error: any) => error.cause === "environment variable is not allowed: HOME",
	);
	await registry.invoke("sandbox.exec", { argv: ["echo"], cwd: "/workspace", timeoutMs: 10 }, context);
	assert.equal((received as { cwd: string }).cwd, "/workspace");
});
