/** scripts/release/galopin-last-changed.sh against a throwaway repository. */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/release/galopin-last-changed.sh");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "glc-"));
	dirs.push(dir);
	const git = (...a: string[]) =>
		execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: dir });
	git("init", "-q");
	mkdirSync(join(dir, "agent"));
	writeFileSync(join(dir, "agent/main.go"), "package main\n");
	writeFileSync(join(dir, "agent/LAST_CHANGED"), "0.1.0\n");
	git("add", ".");
	git("commit", "-qm", "one");
	git("tag", "v0.1.0");
	const commit = (file: string, body: string) => {
		writeFileSync(join(dir, file), body);
		git("add", ".");
		git("commit", "-qm", file);
	};
	const run = (v: string, flag?: string) =>
		spawnSync("bash", [SCRIPT, v, ...(flag ? [flag] : [])], { cwd: dir, encoding: "utf8" });
	const last = () => readFileSync(join(dir, "agent/LAST_CHANGED"), "utf8").trim();
	return { dir, commit, run, last };
}

describe("galopin-last-changed.sh", () => {
	it("leaves the file alone when only docs, tests or Cerea changed", () => {
		const r = repo();
		r.commit("agent/README.md", "docs");
		r.commit("agent/x_test.go", "package main\n");
		r.commit("src.txt", "cerea");
		expect(r.run("0.2.0").status).toBe(0);
		expect(r.last()).toBe("0.1.0");
		expect(r.run("0.2.0", "--check").status).toBe(0);
	});

	it("writes the new version when galopin's code changed, idempotently", () => {
		const r = repo();
		r.commit("agent/main.go", "package main // changed\n");
		expect(r.run("0.2.0", "--check").status).toBe(1);
		expect(r.run("0.2.0").status).toBe(0);
		expect(r.last()).toBe("0.2.0");
		expect(r.run("0.2.0").status).toBe(0);
		expect(r.last()).toBe("0.2.0");
	});
});
