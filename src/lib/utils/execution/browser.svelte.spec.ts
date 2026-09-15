import { describe, expect, it } from "vitest";
import { base } from "$app/paths";
import { getExecutionSession } from "./runtime";
import { RUN_TIMEOUT_MS, pyodideBasePath } from "./protocol";

/**
 * The real thing, in a real browser: the module worker, the vendored Pyodide
 * dist, and the terminate path — no fakes. Skipped when the runtime files
 * are not on the serving origin (the sync step runs with predev/prebuild).
 */
describe.skipIf(await pyodideAbsent())("execution in the browser", () => {
	it(
		"runs python in the worker and captures its output",
		async () => {
			const session = getExecutionSession();
			if (!session) throw new Error("no execution session in the browser");
			const outcome = await session.run("print('from the browser')\n6 * 7");
			expect(outcome.ok).toBe(true);
			expect(outcome.stdout).toContain("from the browser");
			expect(outcome.result).toBe("42");
		},
		{ timeout: 180_000 }
	);

	it(
		"stops runaway code at the wall clock without freezing the tab",
		async () => {
			const session = getExecutionSession();
			if (!session) throw new Error("no execution session in the browser");
			const started = Date.now();
			await expect(session.run("while True: pass")).rejects.toMatchObject({
				kind: "timeout",
			});
			const waited = Date.now() - started;
			// The kill fires within the budget, plus slack for the worker restart.
			expect(waited).toBeLessThan(RUN_TIMEOUT_MS + 10_000);
			// The session rebuilt itself: the next run works on a fresh interpreter.
			const after = await session.run("1 + 1");
			expect(after.ok).toBe(true);
			expect(after.result).toBe("2");
		},
		{ timeout: 180_000 }
	);
});

async function pyodideAbsent(): Promise<boolean> {
	if (typeof window === "undefined") return true;
	try {
		// Probe the base-aware runtime path: production serves the app under
		// a base (e.g. /chat), so the dist is at <base>/pyodide/, not /pyodide/.
		const probeBase = typeof base === "string" && base ? base : import.meta.env.BASE_URL;
		const response = await fetch(`${pyodideBasePath(probeBase)}pyodide.mjs`, {
			method: "HEAD",
		});
		return !response.ok;
	} catch {
		return true;
	}
}
