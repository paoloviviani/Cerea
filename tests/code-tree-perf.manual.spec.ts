/**
 * TEMPORARY measurement harness for brief item 1 (2026-09-25). Not meant to
 * be committed — deleted once the "before"/"after" numbers are captured.
 * Creates one real machine, one workspace, and a large number of sessions,
 * then reloads /code and records the server timing (x-perf-ms headers,
 * temporary) and the client waterfall (response timings + time to first
 * visible agent row).
 */
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { test, expect, E2E_APP_BASE, E2E_APP_URL } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

const SESSION_COUNT = Number(process.env.PERF_SESSION_COUNT ?? 150);
const CONCURRENCY = 10;

test.describe("PERF measure (temporary)", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 300_000 });

	let machine: Machine | null = null;

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine) {
			testInfo.attach("galopin.log", { body: machine.logs(), contentType: "text/plain" });
		}
		await machine?.stop();
		machine = null;
	});

	test(`many sessions (${SESSION_COUNT}) on one device`, async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub });

		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(machine.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("link", { name: new RegExp(machine.name) }).click();
		const deviceId = new URL(page.url()).searchParams.get("device");
		expect(deviceId).toBeTruthy();

		const apiRoot = `${E2E_APP_URL}/api/v2/code`;
		const startedMachine = machine;
		if (!startedMachine) throw new Error("machine did not start");
		const wsRes = await page.request.post(`${apiRoot}/v1/workspaces?device=${deviceId}`, {
			data: { path: startedMachine.workspace, title: "repo" },
		});
		expect(wsRes.ok()).toBe(true);
		const { workspace } = superjson.parse<{ workspace: { id: string } }>(await wsRes.text());

		console.log(`[perf] creating ${SESSION_COUNT} sessions...`);
		const tCreate = Date.now();
		for (let i = 0; i < SESSION_COUNT; i += CONCURRENCY) {
			const batch = Array.from({ length: Math.min(CONCURRENCY, SESSION_COUNT - i) }, () =>
				page.request.post(`${apiRoot}/v1/agents?device=${deviceId}`, {
					data: { workspaceId: workspace.id, provider: "opencode", posture: "plan" },
				})
			);
			const results = await Promise.all(batch);
			for (const r of results) expect(r.ok()).toBe(true);
		}
		console.log(`[perf] created ${SESSION_COUNT} sessions in ${Date.now() - tCreate}ms`);

		// ── Reload: this is the measured event ─────────────────────────────
		const perfHeaders: Record<string, string> = {};
		page.on("response", (res) => {
			const url = res.url();
			if (url.includes("/api/v2/code/devices") || url.includes("/api/v2/code/v1/")) {
				const headerMs = res.headers()["x-perf-ms"];
				if (headerMs) perfHeaders[url] = headerMs;
			}
		});

		const tReload0 = Date.now();
		await page.goto(`${E2E_APP_BASE}/code?device=${deviceId}`);
		const firstAgentRow = page.locator('a[href*="&agent="]').first();
		await expect(firstAgentRow).toBeVisible({ timeout: 30_000 });
		const tVisible = Date.now() - tReload0;

		console.log(`[perf] RESULT time-to-first-agent-row-visible=${tVisible}ms`);
		console.log(`[perf] RESULT server x-perf-ms headers:`, JSON.stringify(perfHeaders, null, 2));
		console.log(`[perf] RESULT galopin log lines:`);
		for (const line of machine.logs().split("\n")) {
			if (line.includes("PERF")) console.log("  " + line);
		}
	});
});
