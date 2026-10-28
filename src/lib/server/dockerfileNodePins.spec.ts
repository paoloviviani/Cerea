import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CVE-2026-111497 (Brotli decoder out-of-bounds write) is fixed in Node 22.23.4,
// 24.22.1 and 26.12.1. A floating `node:24` tag can fall back to a vulnerable
// build, so every Dockerfile must pin an exact patch at or above the fix.
const FIXED: Record<number, [number, number, number]> = {
	22: [22, 23, 4],
	24: [24, 22, 1],
	26: [26, 12, 1],
};

const root = join(import.meta.dirname, "../../..");

function dockerfiles(): string[] {
	return execFileSync("git", ["ls-files", "*Dockerfile*"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
}

function nodeFromTags(text: string): string[] {
	return [...text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*node:(\S+)/gim)].map((m) => m[1]);
}

function atLeastFixed(tag: string): boolean {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+)?(?:@sha256:[0-9a-f]{64})?$/.exec(tag);
	if (!m) return false;
	const v = [Number(m[1]), Number(m[2]), Number(m[3])];
	const min = FIXED[v[0]];
	if (!min) return v[0] > 26;
	return v[1] > min[1] || (v[1] === min[1] && v[2] >= min[2]);
}

describe("Dockerfile Node pins", () => {
	it("rejects a floating tag and a too-old patch", () => {
		expect(atLeastFixed("24-slim")).toBe(false);
		expect(atLeastFixed("24")).toBe(false);
		expect(atLeastFixed("24.22.0-slim")).toBe(false);
		expect(atLeastFixed("22.23.3-slim")).toBe(false);
		expect(atLeastFixed("24.22.1-slim")).toBe(true);
		expect(atLeastFixed("22.23.4-slim@sha256:" + "a".repeat(64))).toBe(true);
	});

	it("finds the Dockerfiles that use a node base", () => {
		const withNode = dockerfiles().filter(
			(f) => nodeFromTags(readFileSync(join(root, f), "utf8")).length
		);
		expect(withNode).toContain("Dockerfile");
		expect(withNode).toContain("kit/tools/mcp/Dockerfile");
	});

	it("pins every FROM node: tag to a fixed exact version", () => {
		for (const f of dockerfiles()) {
			for (const tag of nodeFromTags(readFileSync(join(root, f), "utf8"))) {
				expect(atLeastFixed(tag), `${f}: node:${tag}`).toBe(true);
			}
		}
	});
});
