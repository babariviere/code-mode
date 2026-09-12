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
test("executor bounds discovery, input, code, and tool output", async () => {
	const output = await new CodeModeExecutor({ registry }).execute({
		code: "return await tools.search({});",
		limits: { maxDiscoveryCalls: 0 },
	});
	assert.equal(output.ok, false);
	assert.equal(output.error?.code, "budget-exceeded");
	const tooMuch = await new CodeModeExecutor({ registry }).execute({
		code: "return π.big;",
		payloads: { big: "x".repeat(20) },
		limits: { maxPayloadBytes: 5 },
	});
	assert.equal(tooMuch.error?.code, "result-too-large");
});
test("host policy cannot be widened by invocation policy and formatting is applied", async () => {
	const result = await new CodeModeExecutor({ registry, policy: { allowedTools: ["math.add"] } }).execute({
		code: "return await math.add({a: 1, b: 2});",
		policy: { allowedTools: ["web.*"] },
		resultFormat: "text",
	});
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "type-error");
	assert.equal(typeof result.formatted, "string");
});
test("cancellation returns without awaiting a non-cooperative host tool", async () => {
	const local = new Registry();
	local.register({
		id: "hang.run",
		description: "hang",
		inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
		effect: "none",
		execute: async () => await new Promise<never>(() => {}),
	});
	const controller = new AbortController();
	const started = Date.now();
	const pending = new CodeModeExecutor({ registry: local }).execute({
		code: "return await hang.run({value: 'x'});",
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 10);
	const result = await pending;
	assert.equal(result.error?.code, "cancelled");
	assert.ok(Date.now() - started < 500);
});
test("executor dispatches normalized declarations to the original tool id", async () => {
	const local = new Registry();
	local.register({
		id: "repo.read-file",
		description: "read",
		inputSchema: { type: "object" },
		effect: "none",
		execute: async () => "ok",
	});
	const result = await new CodeModeExecutor({ registry: local }).execute({ code: "return await repo.read_file({});" });
	assert.equal(result.ok, true);
	assert.equal(result.value, "ok");
});
