import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the packed production install, not workspace links or tsx source imports.
const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "code-mode-package-"));
const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
try {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.equal(manifest.private, true, "source distribution must not enable npm publication");
	const packed = JSON.parse(
		execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
			cwd: root,
			encoding: "utf8",
			env,
		}),
	);
	await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
	execFileSync(
		"npm",
		["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed[0].filename)],
		{ cwd: temporary, stdio: "pipe", env },
	);
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		import assert from "node:assert/strict";
		import { CodeModeExecutor, createRegistry } from "@babariviere/code-mode";
		import { PiQuickJsRuntime } from "@babariviere/code-mode/host-pi";
		await import("@babariviere/code-mode/host-agentos");
		await import("@babariviere/code-mode/background-runtime");
		await import("@babariviere/code-mode/protocol");
		const result = await new CodeModeExecutor({ registry: createRegistry() }).execute({ code: "return 42;" });
		assert.equal(result.ok, true, result.error?.message);
		assert.equal(result.value, 42);
		const interactive = await new PiQuickJsRuntime().execute("return await mapLimit([1, 2], async x => x * 2, 1);", async () => null, { timeoutMs: 1000, memoryLimitBytes: 67108864 });
		assert.equal(interactive.terminationReason, "completed", interactive.error);
		assert.deepEqual(interactive.value, [2, 4]);
	`,
		],
		{ cwd: temporary, stdio: "pipe", env },
	);
	console.log("Packed production install and all root exports passed");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
