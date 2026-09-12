import { CodeModeExecutor, Registry } from "../packages/core/index.ts";

const registry = new Registry();
registry.register({
	id: "web.search",
	description: "Search the approved index",
	inputSchema: { type: "object" },
	effect: "none",
	execute: async () => [{ title: "example" }],
});
const result = await new CodeModeExecutor({ registry }).execute({
	code: "const hits = await web.search({query: π.query}); return hits;",
	payloads: { query: "code mode" },
});
console.log(result);
