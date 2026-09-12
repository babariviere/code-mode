import ts from "typescript";
import { CodeModeError } from "./contracts.ts";

export interface TypeCheckError {
	readonly line: number;
	readonly column: number;
	readonly message: string;
	readonly code: number;
}
export interface TypeCheckResult {
	readonly errors: readonly TypeCheckError[];
	readonly javascript?: string;
	readonly sourceMap?: string;
}
const options: ts.TranspileOptions = {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		sourceMap: true,
		strict: true,
		skipLibCheck: true,
	},
};
const checkOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	lib: ["lib.es2022.d.ts"],
	strict: true,
	skipLibCheck: true,
	noEmit: true,
};
export const transpile = (code: string): { javascript: string; sourceMap?: string } => {
	const output = ts.transpileModule(`async function __codeModeMain(){\n${code}\n}`, options);
	return { javascript: output.outputText, ...(output.sourceMapText ? { sourceMap: output.sourceMapText } : {}) };
};
export const typeCheck = (code: string, declarations: string, signal?: AbortSignal): TypeCheckResult => {
	if (signal?.aborted) throw new CodeModeError({ code: "cancelled", message: "Type checking cancelled" });
	const file = "/__code_mode_guest.ts";
	const decl = "/__code_mode_globals.d.ts";
	let source = `async function __codeModeMain(){\n${code}\n}`;
	const host = ts.createCompilerHost(checkOptions);
	const original = host.getSourceFile;
	host.fileExists = (name) => name === file || name === decl || ts.sys.fileExists(name);
	host.readFile = (name) => (name === file ? source : name === decl ? declarations : ts.sys.readFile(name));
	host.getSourceFile = (name, language, onError, newFile) =>
		name === file
			? ts.createSourceFile(file, source, language, true)
			: name === decl
				? ts.createSourceFile(decl, declarations, language, true)
				: original.call(host, name, language, onError, newFile);
	const program = ts.createProgram([file, decl], checkOptions, host);
	if (signal?.aborted) throw new CodeModeError({ code: "cancelled", message: "Type checking cancelled" });
	const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter(
		(d) => d.file?.fileName === file,
	);
	const errors = diagnostics.map((d) => {
		const pos =
			d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
		return {
			line: pos.line + 1,
			column: pos.character + 1,
			message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			code: d.code,
		};
	});
	if (errors.length) return { errors };
	if (signal?.aborted) throw new CodeModeError({ code: "cancelled", message: "Type checking cancelled" });
	const output = transpile(code);
	return { errors, ...output };
};
export const assertTypeChecks = (
	code: string,
	declarations: string,
	signal?: AbortSignal,
): { javascript: string; sourceMap?: string } => {
	const result = typeCheck(code, declarations, signal);
	if (result.errors.length)
		throw new CodeModeError({
			code: "type-error",
			message: result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join("\n"),
		});
	if (!result.javascript)
		throw new CodeModeError({ code: "runtime-error", message: "TypeScript emitted no JavaScript" });
	return { javascript: result.javascript, ...(result.sourceMap ? { sourceMap: result.sourceMap } : {}) };
};
