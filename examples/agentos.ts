import { createAgentOsRegistry } from "../packages/host-agentos/index.ts";
import { CodeModeExecutor } from "../packages/core/index.ts";

const registry = createAgentOsRegistry({
	workspaceRead: async (path) => `read ${path}`,
	sandboxExec: async (request) => ({ exitCode: 0, stdout: request.argv.join(" "), stderr: "", durationMs: 1 }),
});
const result = await new CodeModeExecutor({ registry }).execute({
	code: 'const source = await workspace.read({path: "README.md"}); return source;',
	policy: { allowedCapabilities: ["workspace.read"] },
});
console.log(result);
