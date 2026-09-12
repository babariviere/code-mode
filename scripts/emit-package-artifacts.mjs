import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packages = [
	{ directory: "core", name: "@babariviere/code-mode-core" },
	{ directory: "protocol", name: "@babariviere/code-mode-protocol" },
	{ directory: "background-runtime", name: "@babariviere/code-mode-core" },
	{ directory: "host-agentos", name: "@babariviere/code-mode-core" },
	{ directory: "host-pi", name: "@babariviere/code-mode-core" },
];

const rewriteImports = async (directory, packageName) => {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await rewriteImports(path, packageName);
		else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
			const source = await readFile(path, "utf8");
			const rewritten = source
				.replaceAll("../core/index.js", packageName)
				.replaceAll("../core/index.d.ts", packageName);
			if (rewritten !== source) await writeFile(path, rewritten);
		}
	}
};

for (const { directory, name } of packages) {
	const destination = join("packages", directory, "dist");
	await rm(destination, { recursive: true, force: true });
	await cp(join("dist", "packages", directory), destination, { recursive: true });
	if (directory !== "core" && ["background-runtime", "host-agentos", "host-pi"].includes(directory))
		await rewriteImports(destination, name);
}
