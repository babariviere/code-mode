import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedState } from "./index.ts";
test("state is bounded and JSON serializable", () => {
	const state = new BoundedState({ count: 1 }, 64);
	state.set("name", "worker");
	assert.equal(state.get("count"), 1);
	assert.equal(state.delete("name"), true);
	assert.throws(() => state.set("bad key", 1));
	assert.throws(() => state.set("large", "x".repeat(100)));
});
