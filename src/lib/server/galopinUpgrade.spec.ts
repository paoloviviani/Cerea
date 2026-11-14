import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config", () => ({ config: { GALOPIN_DIST_DIR: "", PUBLIC_ORIGIN: "" } }));

const { renderInstallScript } = await import("./galopinDist");
const { OPENCODE_VERSION } = await import("$lib/codeEnrollCommand");

describe("install.sh --upgrade, run for real against a temporary HOME", () => {
	it("passes agent/packaging/upgrade_test.sh", () => {
		const dir = mkdtempSync(join(tmpdir(), "galopin-upgrade-"));
		try {
			const script = join(dir, "install.sh");
			writeFileSync(
				script,
				renderInstallScript("https://cerea.example/chat", { enrollReady: true })
			);
			const test = resolve(__dirname, "../../../agent/packaging/upgrade_test.sh");
			const run = spawnSync("bash", [test, script, OPENCODE_VERSION], {
				encoding: "utf8",
				timeout: 120_000,
			});
			expect(run.stdout + run.stderr).toContain("all upgrade tests passed");
			expect(run.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 150_000);
});
