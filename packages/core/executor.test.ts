import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeModeExecutor, Registry } from "./index.ts";
const registry = new Registry();
registry.register({
	id: "math.add",
	description: "add",
	inputSchema: { type: "object" },
	effect: "none",
	execute: async (input: unknown) => {
		const v = input as { a: number; b: number };
		return v.a + v.b;
	},
});
test("executor type checks, isolates, and dispatches registered tools", async () => {
	const result = await new CodeModeExecutor({ registry }).execute({
		code: "const value = await math.add({a: 2, b: 3}); return {value, payload: π.answer};",
		payloads: { answer: "ok" },
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.value, { value: 5, payload: "ok" });
});
test("executor exposes discovery and enforces call budgets", async () => {
	const result = await new CodeModeExecutor({ registry }).execute({
		code: "await math.add({a: 1,b: 1}); await math.add({a: 1,b: 1}); return 1;",
		limits: { maxToolCalls: 1 },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "budget-exceeded");
});
test("executor rejects unauthorized tools before execution", async () => {
	let called = false;
	const local = new Registry();
	local.register({
		id: "web.search",
		description: "search",
		inputSchema: { type: "object" },
		effect: "none",
		execute: async () => {
			called = true;
			return [];
		},
	});
	const result = await new CodeModeExecutor({ registry: local }).execute({
		code: "return await web.search({});",
		policy: { deniedTools: ["web.search"] },
	});
	assert.equal(result.ok, false);
	assert.equal(called, false);
});
test("executor cancels runaway programs", async () => {
	const result = await new CodeModeExecutor({ registry }).execute({
		code: "while (true) {}",
		limits: { timeoutMs: 25 },
	});
	assert.equal(result.ok, false);
	assert.ok(result.error?.code === "deadline-exceeded" || result.error?.code === "runtime-error");
});
