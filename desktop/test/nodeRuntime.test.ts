import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureNode } from "../src/main/nodeRuntime.ts";

function fakeResources(content = "#!node-binary") {
	const res = mkdtempSync(join(tmpdir(), "res-"));
	const dir = join(res, "node");
	mkdirSync(join(dir, "bin"), { recursive: true });
	mkdirSync(join(dir, "lib", "node_modules", "npm", "bin"), { recursive: true });
	writeFileSync(join(dir, "bin", "node"), content, { mode: 0o755 });
	writeFileSync(join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "x");
	symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(dir, "bin", "npm"));
	writeFileSync(
		join(dir, ".node-sha256"),
		`${createHash("sha256").update(content).digest("hex")}\n24.22.2\n`
	);
	return res;
}

describe("the shipped Node", () => {
	it("is copied once into the data directory, symlinks kept, and found there afterwards", () => {
		const resources = fakeResources();
		const userData = mkdtempSync(join(tmpdir(), "ud-"));
		const a = ensureNode({ resources, userData })!;
		expect(a.binDir).toBe(join(userData, "node", "24.22.2", "bin"));
		expect(lstatSync(join(a.binDir, "npm")).isSymbolicLink()).toBe(true);
		const marker = join(userData, "node", "24.22.2", ".installed-from");
		expect(existsSync(marker)).toBe(true);
		const mtime = lstatSync(join(a.binDir, "node")).mtimeMs;
		ensureNode({ resources, userData });
		expect(lstatSync(join(a.binDir, "node")).mtimeMs).toBe(mtime); // not copied again
	});

	it("replaces a copy that no longer matches the hash built into the app", () => {
		const resources = fakeResources();
		const userData = mkdtempSync(join(tmpdir(), "ud-"));
		const a = ensureNode({ resources, userData })!;
		writeFileSync(join(a.binDir, "node"), "tampered");
		ensureNode({ resources, userData });
		expect(readFileSync(join(a.binDir, "node"), "utf8")).toBe("#!node-binary");
	});

	it("is absent in a development run", () => {
		expect(ensureNode({ resources: undefined, userData: tmpdir() })).toBeUndefined();
		expect(
			ensureNode({ resources: mkdtempSync(join(tmpdir(), "none-")), userData: tmpdir() })
		).toBeUndefined();
	});

	it("pins a hash for every platform the app is built for", () => {
		const pins = JSON.parse(readFileSync(new URL("../node-pins.json", import.meta.url), "utf8"));
		expect(Object.keys(pins.sha256).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
		]);
		for (const h of Object.values(pins.sha256)) expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(pins.version).toMatch(/^24\./);
	});
});
