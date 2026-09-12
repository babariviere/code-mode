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
