import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const visit = async (directory) => {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await visit(path);
		else if (entry.name.endsWith(".d.ts")) {
			const source = await readFile(path, "utf8");
			const rewritten = source.replace(/\.ts(["'])/g, ".d.ts$1");
			if (rewritten !== source) await writeFile(path, rewritten);
		}
	}
};
await visit("dist");
