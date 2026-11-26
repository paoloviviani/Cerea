/**
 * Idle energy measurement, not a pass/fail test: it only runs with `ENERGY=1`.
 *
 * Opens each main surface, leaves it alone for `ENERGY_SECONDS` (default 120)
 * once as a visible tab and once as a hidden one, and appends a JSON line per
 * run to `$ENERGY_OUT` (default /var/tmp/energy-tmp/results.jsonl): CDP
 * `Performance.getMetrics` deltas (TaskDuration, ScriptDuration, LayoutCount,
 * RecalcStyleCount), the requests made, and how many timer / animation-frame
 * callbacks fired. Re-run recipe: docs/dev/energy.md.
 *
 * "Hidden" overrides `document.hidden` / `visibilityState` and fires
 * `visibilitychange`, so it measures what the app's own code does when told
 * the tab is hidden. It does not reproduce the browser's own 1 Hz timer
 * throttling of a really hidden tab (that only helps further).
 */
import { appendFileSync } from "node:fs";
import type { Page } from "playwright/test";
import superjson from "superjson";
import { test, expect, E2E_APP_BASE, stubCodeStatus } from "./fixtures";

const SECONDS = Number(process.env.ENERGY_SECONDS ?? 120);
const OUT = process.env.ENERGY_OUT ?? "/var/tmp/energy-tmp/results.jsonl";
const LABEL = process.env.ENERGY_LABEL ?? "run";
const ONLY = process.env.ENERGY_SURFACES?.split(",");

test.skip(process.env.ENERGY !== "1", "set ENERGY=1 to measure");

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";
const json = (data: unknown) => ({
	contentType: "application/json",
	body: superjson.stringify(data),
});

const COUNTERS = `
(() => {
	const c = { timeout: 0, interval: 0, raf: 0 };
	window.__energy = c;
	const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
	window.setTimeout = (fn, ...a) => st(typeof fn === 'function' ? (...x) => { c.timeout++; return fn(...x); } : fn, ...a);
	window.setInterval = (fn, ...a) => si(typeof fn === 'function' ? (...x) => { c.interval++; return fn(...x); } : fn, ...a);
	window.requestAnimationFrame = (fn) => raf((t) => { c.raf++; fn(t); });
})();
`;

async function stubAgents(page: Page) {
	await page.route("**/api/v2/code/devices", (r) =>
		r.fulfill(json({ devices: [{ id: DEVICE, name: "e2e box", status: "paired", online: true }] }))
	);
	const agent = {
		id: AGENT,
		title: "e2e agent",
		provider: "opencode",
		state: "working",
		cwd: "/repo",
		workspaceId: WS,
		modeId: "plan",
		modelId: "pystino/coder-large",
	};
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (r) =>
		r.fulfill(json({ agent, cwd: "/repo" }))
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (r) =>
		r.fulfill(json({ workspaces: [{ id: WS, name: "repo", path: "/repo" }] }))
	);
	await page.route("**/api/v2/code/v1/agents?*", (r) => r.fulfill(json({ agents: [agent] })));
	await page.route("**/api/v2/code/v1/providers/**", (r) =>
		r.fulfill(json({ modes: [], models: [] }))
	);
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (r) =>
		r.fulfill({ status: 200, contentType: "text/event-stream", body: "" })
	);
}

const LONG = Array.from({ length: 60 }, (_, i) => [
	{ from: "user" as const, content: `question ${i}` },
	{
		from: "assistant" as const,
		content: `answer ${i}\n\n${"lorem ipsum dolor sit amet ".repeat(40)}`,
		extra: { updates: [{ type: "finalAnswer", text: `answer ${i}`, interrupted: false }] },
	},
]).flat();

const SURFACES: Record<
	string,
	(ctx: { page: Page; seed: (m?: never) => Promise<string> }) => Promise<string>
> = {
	"new-chat": async () => `${E2E_APP_BASE}/`,
	"long-chat": async ({ seed }) => `${E2E_APP_BASE}/conversation/${await seed()}`,
	agents: async ({ page }) => {
		await stubAgents(page);
		return `${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`;
	},
	settings: async () => `${E2E_APP_BASE}/settings`,
};

for (const name of Object.keys(SURFACES)) {
	if (ONLY && !ONLY.includes(name)) continue;
	for (const mode of ["visible", "hidden"] as const) {
		test(`${name} ${mode}`, async ({ page, seedConversation }) => {
			test.setTimeout((SECONDS + 90) * 1000);
			await stubCodeStatus(page);
			await page.addInitScript(COUNTERS);
			const seed = async () =>
				(
					await seedConversation({
						title: "Long history",
						messages: [{ from: "system", content: "" }, ...LONG],
					})
				).toString();
			const url = await SURFACES[name]({ page, seed: seed as never });
			let requests = 0;
			const paths: Record<string, number> = {};
			await page.goto(url);
			await page.waitForTimeout(5000);
			if (mode === "hidden") {
				await page.evaluate(() => {
					Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
					Object.defineProperty(document, "visibilityState", {
						configurable: true,
						get: () => "hidden",
					});
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await page.waitForTimeout(1000);
			}
			page.on("request", (req) => {
				requests++;
				const p = new URL(req.url()).pathname;
				paths[p] = (paths[p] ?? 0) + 1;
			});
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Performance.enable");
			const read = async () => {
				const { metrics } = await cdp.send("Performance.getMetrics");
				return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
			};
			const c0 = await page.evaluate(() => ({
				...(window as never as { __energy: object }).__energy,
			}));
			const m0 = await read();
			await page.waitForTimeout(SECONDS * 1000);
			const m1 = await read();
			const c1 = (await page.evaluate(() => ({
				...(window as never as { __energy: Record<string, number> }).__energy,
			}))) as Record<string, number>;
			// What is still animating: an infinite animation on an idle surface is the usual culprit.
			const animations = await page.evaluate(() =>
				document
					.getAnimations()
					.filter(
						(a) =>
							a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity
					)
					.map((a) => {
						const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
						const name = (a as CSSAnimation).animationName ?? a.id;
						return `${name} on ${target?.tagName.toLowerCase() ?? "?"}.${String(target?.getAttribute("class") ?? "").slice(0, 60)}`;
					})
			);
			const d = (k: string) => +((m1[k] ?? 0) - (m0[k] ?? 0)).toFixed(4);
			const perMin = (n: number) => +((n * 60) / SECONDS).toFixed(1);
			const row = {
				label: LABEL,
				surface: name,
				mode,
				seconds: SECONDS,
				taskMsPerMin: perMin(d("TaskDuration") * 1000),
				scriptMsPerMin: perMin(d("ScriptDuration") * 1000),
				layoutPerMin: perMin(d("LayoutCount")),
				recalcPerMin: perMin(d("RecalcStyleCount")),
				requestsPerMin: perMin(requests),
				timeoutPerMin: perMin(c1.timeout - (c0 as Record<string, number>).timeout),
				intervalPerMin: perMin(c1.interval - (c0 as Record<string, number>).interval),
				rafPerMin: perMin(c1.raf - (c0 as Record<string, number>).raf),
				paths,
				animations,
			};
			appendFileSync(OUT, JSON.stringify(row) + "\n");
			expect(true).toBe(true);
		});
	}
}
