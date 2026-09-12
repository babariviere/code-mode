import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeModeExecutor } from "../core/index.ts";
import { createPiRegistry, PiQuickJsRuntime } from "./index.ts";

const options = { timeoutMs: 1_000, memoryLimitBytes: 64 * 1024 * 1024 };

test("selected Pi callbacks support explicit capability IDs", async () => {
	const registry = createPiRegistry({
		selectedTools: [
			{
				id: "web.search",
				name: "web_search",
				description: "Search",
				inputSchema: { type: "object" },
				execute: () => "found",
			},
		],
	});
	assert.deepEqual(
		registry.discover().map((tool) => tool.id),
		["web.search"],
	);
	assert.match(registry.declarations(), /declare namespace web/);
	assert.doesNotMatch(registry.declarations(), /declare namespace (pi|extensions)/);
	const result = await new CodeModeExecutor({ registry }).execute({ code: "return await web.search({});" });
	assert.equal(result.ok, true);
	assert.equal(result.value, "found");
});

test("Pi host installs web only when explicitly selected and preserves guest helpers", async () => {
	const runtime = new PiQuickJsRuntime();
	const absent = await runtime.execute("return typeof web;", async () => null, options);
	assert.equal(absent.value, "undefined");
	const result = await runtime.execute(
		'console.log("checking"); return { found: await web.search({query: π.query}), values: await mapLimit([1, 2], async x => x * 2, 1), cwd: process.cwd(), legacy: typeof extensions };',
		async (ref, args) => ({ ref, args }),
		{
			...options,
			providers: ["web"],
			payloads: { query: "hello" },
			process: { env: { HOME: "/home/test" }, platform: "test", arch: "test", cwd: "/workspace" },
		},
	);
	assert.equal(result.terminationReason, "completed", result.error);
	assert.deepEqual(result.value, {
		found: { ref: "web.search", args: { query: "hello" } },
		values: [2, 4],
		cwd: "/workspace",
		legacy: "undefined",
	});
	assert.deepEqual(result.logs, ["checking"]);
});
