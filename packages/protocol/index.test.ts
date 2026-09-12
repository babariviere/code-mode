import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEvent, encodeEvent, type EventEnvelope } from "./index.ts";
test("protocol round trips newline-delimited events", () => {
	const event: EventEnvelope = { id: "1", event: { type: "workflow.progress", workflowId: "w", message: "ok", at: 1 } };
	assert.deepEqual(decodeEvent(encodeEvent(event).trim()), event);
});
