import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	THINK_CLOSE,
	THINK_OPEN,
	thinkBlockCapturePattern,
	thinkBlockPattern,
	thinkBlockWholePattern,
	thinkTagPattern,
} from "./thinkTags";

/**
 * The literal think tag lives only in thinkTags.ts (see its header). The
 * search pattern is built from pieces so this file holds no literal either.
 */
const LITERAL = new RegExp("think" + ">");
const ALLOWED = join("src", "lib", "utils", "thinkTags.ts");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		if (!/\.(ts|js|svelte)$/.test(name)) return [];
		if (/\.(spec|test)\.[tj]s$/.test(name) || path.includes("__tests__")) return [];
		return path === ALLOWED ? [] : [path];
	});
}

describe("think tags", () => {
	it("have the exact tag text", () => {
		expect(THINK_OPEN).toBe("<" + "think" + ">");
		expect(THINK_CLOSE).toBe("<" + "/think" + ">");
	});

	it("patterns match as the old literals did", () => {
		const text = `a${THINK_OPEN}x${THINK_CLOSE}b${THINK_OPEN}open`;
		expect(text.replace(thinkBlockPattern("g"), "")).toBe("ab");
		expect([...text.matchAll(thinkBlockCapturePattern("g"))].map((m) => m[1])).toEqual([
			"x",
			"open",
		]);
		expect(text.split(thinkBlockWholePattern("gi"))[1]).toBe(`${THINK_OPEN}x${THINK_CLOSE}`);
		expect(`${THINK_OPEN}t${THINK_CLOSE}`.replace(thinkTagPattern("gi"), "")).toBe("t");
	});

	it("appear in no other non-test source under src, not even in a comment", () => {
		const offenders = sources("src").filter((path) => LITERAL.test(readFileSync(path, "utf-8")));
		expect(offenders).toEqual([]);
	});
});
