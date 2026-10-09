/**
 * The built-in office skills' bundled scripts, run in the real vendored
 * Pyodide — the same interpreter the browser gets, driven from Node.
 *
 * This is the CI-facing half of `scripts/pyodide_skills_check.mjs`, which
 * does the actual work and prints one JSON result per skill. The dist is
 * generated, not committed (`npm run sync-pyodide` fetches ~325 MB), so —
 * exactly like the execution pipeline's own integration spec — the suite
 * skips when `static/pyodide/` is absent rather than failing on a missing
 * file. With it, a bundled script that breaks here breaks in the chat.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const distPresent = existsSync(path.join(repoRoot, "static/pyodide/pyodide.asm.wasm"));

describe.skipIf(!distPresent)(
	"pyodide skills check (the standalone script prints the per-skill details)",
	() => {
		it("runs every bundled office-skill script in Pyodide and re-opens the outputs", async () => {
			const { stdout } = await execFileAsync(
				process.execPath,
				[path.join(repoRoot, "scripts/pyodide_skills_check.mjs"), "--json"],
				{ timeout: 540_000, maxBuffer: 32 * 1024 * 1024, cwd: repoRoot }
			);
			const parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<
				string,
				{ ok: boolean; detail: string }
			>;
			for (const [skill, result] of Object.entries(parsed)) {
				expect(result.ok, `${skill}: ${result.detail}`).toBe(true);
			}
		}, 600_000);
	}
);
