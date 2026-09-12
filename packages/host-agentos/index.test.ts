import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentOsRegistry } from "./index.ts";

const context = {
	signal: new AbortController().signal,
	invocationId: "symlink-test",
	reportProgress: () => {},
	state: {},
} as never;

test("AgentOS workspace bindings reject symlink escapes", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "code-mode-host-agentos-"));
	const workspaceRoot = join(temporaryRoot, "workspace");
	const outsideRoot = join(temporaryRoot, "outside");
	await Promise.all([mkdir(workspaceRoot), mkdir(outsideRoot)]);
	await writeFile(join(outsideRoot, "secret.txt"), "secret");
	await Promise.all([
		symlink(join(outsideRoot, "secret.txt"), join(workspaceRoot, "read-link")),
		symlink(outsideRoot, join(workspaceRoot, "write-link")),
		symlink(outsideRoot, join(workspaceRoot, "cwd-link")),
	]);

	let readCalled = false;
	let writeCalled = false;
	let sandboxCalled = false;
	try {
		const registry = createAgentOsRegistry(
			{
				workspaceRead: async () => {
					readCalled = true;
					return "unexpected";
				},
				workspaceWrite: async () => {
					writeCalled = true;
				},
				sandboxExec: async () => {
					sandboxCalled = true;
					return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
				},
			},
			{ workspaceRoot },
		);
		const escapes = [
			() => registry.invoke("workspace.read", { path: "read-link" }, context),
			() => registry.invoke("workspace.write", { path: "write-link/new.txt", content: "blocked" }, context),
			() => registry.invoke("sandbox.exec", { argv: ["pwd"], cwd: "cwd-link" }, context),
		];
		for (const escape of escapes)
			await assert.rejects(escape, (error: any) => error.cause === "path escapes workspace");
		assert.equal(readCalled, false);
		assert.equal(writeCalled, false);
		assert.equal(sandboxCalled, false);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
