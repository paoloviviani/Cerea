import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadDirSafe } from "../src/main/cdpPolicy.ts";

describe("a download directory must be safe to write into", () => {
	const base = mkdtempSync(join(tmpdir(), "dl-"));
	const uid = process.getuid?.() ?? 0;
	const make = (name: string, mode: number) => {
		const d = join(base, name);
		mkdirSync(d);
		chmodSync(d, mode);
		return d;
	};

	it("accepts a real directory of ours that others cannot write", () => {
		expect(downloadDirSafe(make("ok", 0o700), uid)).toBe(true);
		expect(downloadDirSafe(make("ok-readable", 0o755), uid)).toBe(true);
	});

	it("refuses a symlink, even to a good directory", () => {
		const real = make("real", 0o700);
		const link = join(base, "link");
		symlinkSync(real, link);
		expect(downloadDirSafe(link, uid)).toBe(false);
	});

	it("refuses another user's directory", () => {
		expect(downloadDirSafe(make("theirs", 0o700), uid + 1)).toBe(false);
	});

	it("refuses a group-writable and a world-writable directory", () => {
		expect(downloadDirSafe(make("group", 0o770), uid)).toBe(false);
		expect(downloadDirSafe(make("world", 0o707), uid)).toBe(false);
	});

	it("refuses a missing path and a file", () => {
		expect(downloadDirSafe(join(base, "missing"), uid)).toBe(false);
		const file = join(base, "afile");
		writeFileSync(file, "x");
		expect(downloadDirSafe(file, uid)).toBe(false);
	});
});
