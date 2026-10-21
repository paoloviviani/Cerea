import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rollup and esbuild read a pure-call annotation (`@` or `#`, then
 * `__PURE__` or `__NO_SIDE_EFFECTS__`) in ANY comment, line comments
 * included, and delete the call that follows when its result is unused. A
 * comment that merely quoted one removed ChatWindow's setArtifactsContext
 * call from the v0.18.2 build, and every file card and artifact lost its
 * context. Our own sources never need one, so none may appear.
 */
const ANNOTATION = new RegExp("[@#]__" + "(PURE|NO_SIDE_EFFECTS)" + "__");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(ts|js|svelte)$/.test(name) ? [path] : [];
	});
}

describe("bundler annotations", () => {
	it("appear nowhere in src, not even in a comment", () => {
		const offenders = sources("src").filter((path) => ANNOTATION.test(readFileSync(path, "utf-8")));
		expect(offenders).toEqual([]);
	});
});
