import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeModeError, Registry, generateDeclarations } from "./index.ts";
const tool = (id: `${string}.${string}`) => ({
	id,
	description: id,
	inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	effect: "none" as const,
	execute: async (input: unknown) => input,
});
test("registry rejects invalid ids, reserved discovery, and collisions", () => {
	const registry = new Registry();
	assert.throws(() => registry.register({ ...tool("Bad.id" as `${string}.${string}`) }), CodeModeError);
	assert.throws(() => registry.register({ ...tool("tools.search") }), CodeModeError);
	registry.register(tool("web.search"));
	assert.throws(() => registry.register(tool("web.search")), CodeModeError);
});
test("policy filters discovery and generated namespace declarations", () => {
	const registry = new Registry();
	registry.register(tool("web.search"));
	registry.register(tool("sandbox.exec"));
	assert.equal(registry.discover("web").length, 1);
	assert.equal(registry.discover(undefined, { allowedCapabilities: ["sandbox.exec"] }).length, 0);
	const declarations = generateDeclarations([tool("web.search")]);
	assert.match(declarations, /declare namespace web/);
	assert.match(declarations, /function search/);
	assert.doesNotMatch(declarations, /declare namespace extensions/);
});
test("registry validates inputs and outputs and uses bijective declaration bindings", async () => {
	const registry = new Registry();
	registry.register({
		id: "repo.read-file",
		description: "read",
		inputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } },
		outputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } },
		effect: "none",
		execute: async () => ({ value: 1 }),
	});
	assert.equal(registry.declarationBindings()[0]?.name, "read_file");
	await assert.rejects(() => registry.invoke("repo.read-file", { value: 1.5 }, {} as never), /integer/);
	const restricted = new Registry();
	restricted.register({ ...tool("web.fetch"), capabilities: ["workspace.read", "github.write"] });
	assert.equal(restricted.discover(undefined, { allowedCapabilities: ["workspace.read"] }).length, 0);
});
test("registry rejects normalized declaration collisions", () => {
	const tools = [tool("web.a-b"), tool("web.a_b")];
	assert.throws(() => generateDeclarations(tools), /collision/);
});
