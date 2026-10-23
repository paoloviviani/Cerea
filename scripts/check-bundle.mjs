// Production-bundle check, run after `vite build` (the Dockerfile does).
//
// Rollup deletes a call whose result is unused when anything in its input
// carries a pure-call annotation, comments and dependencies included, so a
// source-only check cannot prove the call survived. v0.18.2 shipped a build
// with ChatWindow's setArtifactsContext call gone: every file card fell back
// to the plain card and no artifact opened. This reads the built client
// chunks and fails when the call that feeds the file cards is missing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The call as the minifier leaves it: `name({get registry(){...},get fileRegistry(){...` .
const CONTEXT_CALL = /[\w$]+\(\{get registry\(\)\{[^}]*\},get fileRegistry\(\)\{/;

/**
 * The problems with a set of built client chunks, empty when it is sound.
 * @param {string[]} chunks
 * @returns {string[]}
 */
export function bundleProblems(chunks) {
	return chunks.some((source) => CONTEXT_CALL.test(source))
		? []
		: ["no chunk contains the artifacts context call (setArtifactsContext in ChatWindow)"];
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return jsFiles(path);
		return name.endsWith(".js") ? [path] : [];
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2] ?? "build/client";
	const problems = bundleProblems(jsFiles(root).map((path) => readFileSync(path, "utf-8")));
	for (const problem of problems) console.error(`bundle check: ${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log("bundle check: ok");
}
