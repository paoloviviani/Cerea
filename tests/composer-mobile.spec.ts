/**
 * The composer's one-row mobile toolbar (/code and chat), hermetically: the
 * /code endpoints are stubbed at the network layer (the pills/answer specs'
 * pattern), chat runs the real hermetic stack.
 *
 * What is pinned here, at 390×844 (the operator's phone): the `+`, every
 * pill, the context ring and send share one row (their boxes overlap
 * vertically, no second row); the pill group never wraps; auto-accept drops
 * to its shield icon alone but keeps its accessible name and its
 * `aria-pressed` on/off state; a machine-policy veto stays tappable (not
 * `disabled`) and reveals its reason on tap, since there is no hover on a
 * phone. At 1280×800, the same composer keeps today's text labels (desktop
 * is unchanged).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Locator, Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const VETO_NOTE =
	"This machine's policy vetoes auto-accept: re-run `galopin enroll … --allow-auto-accept`, then restart `run`.";

const AUTO_ACCEPT = {
	id: "auto_accept",
	label: "Auto Accept",
	description: "Automatically approves OpenCode tool permission prompts.",
	value: false,
};

const BACKEND = {
	id: "opencode",
	version: "1.18.31",
	capabilities: {
		diff: true,
		children: true,
		usage: true,
		compact: true,
		images: true,
		files: true,
		worktrees: false,
		autoAccept: true,
		efforts: true,
		questions: true,
	},
};

/** One SSE frame in the bridge's wire shape, as `code-context-meter.spec.ts` uses it. */
const frame = (payload: unknown) => `event: update\ndata: ${JSON.stringify(payload)}\n\n`;

async function installStubs(page: Page, options: { blocked?: boolean } = {}) {
	const feature = options.blocked
		? { ...AUTO_ACCEPT, blockedReason: VETO_NOTE }
		: { ...AUTO_ACCEPT };

	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired", backends: [BACKEND] }],
			}),
		})
	);
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: {
					id: AGENT,
					title: "e2e agent",
					provider: "opencode",
					state: "idle",
					cwd: "/repo",
					workspaceId: WS,
					modeId: "build",
					modelId: "pystino/coder-large",
					effort: "high",
				},
				features: [feature],
				cwd: "/repo",
			}),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ workspaces: [{ id: WS, name: "repo", path: "/repo" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				modes: [
					{ id: "plan", label: "Plan", description: "Proposes; asks before it writes." },
					{ id: "build", label: "Build", description: "May edit files." },
				],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				models: [
					{
						id: "pystino/coder-large",
						label: "Coder Large With A Rather Long Name",
						isDefault: true,
						efforts: ["low", "medium", "high"],
					},
				],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/providers/opencode/features?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ features: [feature] }) })
	);

	// No `max`: a raw token count, "20.2k" — the brief's own repro number.
	const stream = [
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		frame({
			type: "usage",
			usage: { used: 20200, input: 18000, output: 1500, cacheRead: 700, reasoning: 0 },
		}),
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);
}

const goto = (page: Page) =>
	page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

/** Two boxes share a row when one is not entirely above or below the other. */
function overlapsVertically(
	a: { y: number; height: number },
	b: { y: number; height: number }
): boolean {
	return a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error(`no bounding box for ${locator}`);
	return b;
}

test.describe("/code composer at 390×844", () => {
	test.beforeEach(async ({ page }) => {
		await installStubs(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();
	});

	test("the +, every pill, the ring and send share one unwrapped row", async ({ page }) => {
		const attach = page.getByRole("button", { name: "Add attachment" });
		const mode = page.getByRole("button", { name: "Build" });
		const model = page.getByRole("button", { name: "Coder Large With A Rather Long Name" });
		const effort = page.getByRole("button", { name: "Thinking effort" });
		const autoAccept = page.getByRole("button", { name: "Auto Accept" });
		const ring = page.getByRole("button", { name: "20.2k" });
		const send = page.getByRole("button", { name: "Send message" });

		const all = [attach, mode, model, effort, autoAccept, ring, send];
		for (const locator of all) {
			await expect(locator).toBeVisible();
		}

		const boxes = await Promise.all(all.map(box));
		for (let i = 1; i < boxes.length; i++) {
			expect(overlapsVertically(boxes[0], boxes[i])).toBe(true);
		}
		// One row means pill-sized boxes throughout — not a tall stack.
		const heights = boxes.map((b) => b.height);
		expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(20);

		// The `+`, ring and send sit inside the viewport; the pill group
		// between them is free to run past it (it scrolls, checked below).
		for (const locator of [attach, ring, send]) {
			const b = await box(locator);
			expect(b.x + b.width).toBeLessThanOrEqual(390 + 0.5);
		}

		// Auto-accept is icon-only here: a near-square box, not the wide pill
		// desktop shows with the label alongside.
		const autoAcceptBox = await box(autoAccept);
		expect(autoAcceptBox.width).toBeLessThan(36);

		// The model name truncates rather than pushing the row wider.
		const modelBox = await box(model);
		expect(modelBox.width).toBeLessThan(120);

		await expect(autoAccept).toHaveAttribute("aria-pressed", "false");

		await page.screenshot({ path: "test-results/mobile-composer-code-390.png" });
	});

	test("auto-accept and the ring keep an accessible name while going icon-only", async ({
		page,
	}) => {
		const autoAccept = page.getByRole("button", { name: "Auto Accept" });
		const ring = page.getByRole("button", { name: "20.2k" });

		// The name survives (matched above); the visible label is what
		// collapses — `sr-only`, not `display:none`, keeps the name intact.
		const autoAcceptLabelBox = await box(autoAccept.locator("span").first());
		expect(autoAcceptLabelBox.width).toBeLessThan(2);
		const ringLabelBox = await box(ring.locator("span").first());
		expect(ringLabelBox.width).toBeLessThan(2);
	});
});

test.describe("/code composer: a machine-policy veto on mobile", () => {
	test("stays tappable (not disabled) and reveals the veto reason on tap", async ({ page }) => {
		await installStubs(page, { blocked: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const pill = page.getByRole("button", { name: "Auto Accept" });
		await expect(pill).toBeVisible();
		await expect(pill).toBeEnabled();
		await expect(page.getByText(VETO_NOTE)).toHaveCount(0);

		await pill.click();
		await expect(page.getByText(VETO_NOTE)).toBeVisible();
	});
});

test.describe("/code composer at 1280×800 (desktop unchanged)", () => {
	test("keeps the text labels: Auto Accept and the ring's value", async ({ page }) => {
		await installStubs(page);
		await page.setViewportSize({ width: 1280, height: 800 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const autoAccept = page.getByRole("button", { name: "Auto Accept" });
		const ring = page.getByRole("button", { name: "20.2k" });
		await expect(autoAccept).toBeVisible();
		await expect(ring).toBeVisible();

		const autoAcceptLabelBox = await box(autoAccept.locator("span").first());
		expect(autoAcceptLabelBox.width).toBeGreaterThan(10);
		const ringLabelBox = await box(ring.locator("span").first());
		expect(ringLabelBox.width).toBeGreaterThan(10);

		await page.screenshot({ path: "test-results/mobile-composer-code-desktop.png" });
	});

	test("a machine-policy veto keeps its old disabled-plus-banner shape", async ({ page }) => {
		await installStubs(page, { blocked: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const pill = page.getByRole("button", { name: "Auto Accept" });
		await expect(pill).toBeVisible();
		await expect(pill).toBeDisabled();
		await expect(page.getByText(VETO_NOTE)).toBeVisible();
	});
});

test.describe("chat composer at 390×844", () => {
	test("the +, web search and tool-approval pills share one row inside the viewport", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${E2E_APP_BASE}/`);

		const attach = page.getByRole("button", { name: "Add attachment" });
		const webSearch = page.getByRole("button", { name: "Web search" });
		const toolApproval = page.getByRole("button", { name: /^Tools (ask first|auto-approved)$/ });

		await expect(attach).toBeVisible();
		await expect(webSearch).toBeVisible();
		await expect(toolApproval).toBeVisible();

		const [attachBox, webBox, toolBox] = await Promise.all(
			[attach, webSearch, toolApproval].map(box)
		);
		expect(overlapsVertically(attachBox, webBox)).toBe(true);
		expect(overlapsVertically(attachBox, toolBox)).toBe(true);

		// The `+` sits inside the viewport regardless of how the pills past it
		// overflow — it must never scroll away with them.
		expect(attachBox.x).toBeGreaterThanOrEqual(-0.5);
		expect(attachBox.x + attachBox.width).toBeLessThanOrEqual(390 + 0.5);

		// The composer never forces the page itself wider than the viewport.
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(390 + 1);

		await page.screenshot({ path: "test-results/mobile-composer-chat-390.png" });
	});

	test("the model/effort row under the composer does not overflow the viewport", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${E2E_APP_BASE}/`);

		const pill = page.getByRole("button", { name: "Model and effort" });
		await expect(pill).toBeVisible();
		const pillBox = await box(pill);
		expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(390 + 0.5);

		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth).toBeLessThanOrEqual(390 + 1);
	});
});

test.describe("chat composer at 1280×800 (desktop unchanged)", () => {
	test("keeps the model pill's text label and the tool pills' text", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${E2E_APP_BASE}/`);

		await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("Model:");
		await expect(page.getByRole("button", { name: "Web search" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Tools ask first" })).toBeVisible();

		await page.screenshot({ path: "test-results/mobile-composer-chat-desktop.png" });
	});
});
