import { describe, expect, it } from "vitest";
import { staticEscalateReason } from "./static";

const r = (tool: string, ...targets: string[]) => staticEscalateReason({ tool, targets });

describe("the static escalate list", () => {
	it("galopin's and opencode's own state and config", () => {
		expect(r("edit", "/home/u/.config/galopin/policy.json")).toMatch(/configuration/);
		expect(r("edit", "/home/u/.local/share/galopin/audit.log")).toMatch(/configuration/);
		expect(r("edit", "/home/u/.config/opencode/opencode.json")).toMatch(/configuration/);
		expect(r("bash", "galopin policy set --limit command=run")).toMatch(/configuration/);
	});
	it("credential stores and .env files", () => {
		for (const p of [
			"/home/u/.ssh/authorized_keys",
			"~/.aws/credentials",
			"/w/.env",
			"/w/.env.local",
			"cat ~/.npmrc",
			"/home/u/.config/gh/hosts.yml",
		]) {
			expect(r("read", p), p).toMatch(/credentials/);
		}
	});
	it("CI configuration writes, not reads", () => {
		for (const p of [
			"/w/.github/workflows/ci.yml",
			"/w/.gitlab-ci.yml",
			"/w/Jenkinsfile",
			"/w/.circleci/config.yml",
		]) {
			expect(r("edit", p), p).toMatch(/CI/);
			expect(r("read", p), p).toBeNull();
		}
	});
	it("writes into a repository's .git, not reads and not look-alikes", () => {
		for (const p of [
			"/w/.git/config",
			"/w/.git/hooks/pre-commit",
			".git/info/attributes",
			"sub/.git/config",
			".git",
		]) {
			expect(r("edit", p), p).toMatch(/git directory/);
			expect(r("read", p), p).toBeNull();
		}
		for (const p of [
			"/w/.gitignore",
			"/w/.github/CODEOWNERS",
			"/w/.husky/pre-commit",
			"/w/.gitattributes",
			"/w/dot.git/x",
		]) {
			expect(r("edit", p), p).toBeNull();
		}
	});
	it("ordinary work passes", () => {
		for (const [t, p] of [
			["bash", "npm test"],
			["edit", "/w/src/app.ts"],
			["bash", "git commit -m 'env handling'"],
			["edit", "/w/docs/ssh-setup.md"],
		] as const) {
			expect(r(t, p), p).toBeNull();
		}
	});
});
