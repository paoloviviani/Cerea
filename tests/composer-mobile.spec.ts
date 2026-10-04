/**
 * The composer's one-row mobile toolbar (/code and chat), hermetically: the
 * /code endpoints are stubbed at the network layer (the pills/answer specs'
 * pattern), chat runs the real hermetic stack.
 *
 * What is pinned here, at 390×844 (the operator's phone): the `+`, every
 * pill, the context ring and send share one row (their boxes overlap
 * vertically, no second row); the pill group never wraps; the permission
 * selector (Deny · Ask · Allow) stays one pill-height group of three labelled
 * segments with its accessible name and its `aria-checked` state, and its
 * "what the ceiling still caps" note steps aside on a phone (the Allow
 * segment's title carries it). At 1280×800, the same composer keeps its text
 * labels and shows that note under Allow, and the `+`, the pills, the ring and
 * send share one row too (brief item 2) — including with the note showing,
 * which grows the row and must not strand the `+` and send away from it (a
 * `position: absolute` send button pinned to the composer's corner, not a
 * flex sibling of the row it was meant to share).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Locator, Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

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
		efforts: true,
		questions: true,
	},
};

/** One SSE frame in the bridge's wire shape, as `code-context-meter.spec.ts` uses it. */
const frame = (payload: unknown) => `event: update\ndata: ${JSON.stringify(payload)}\n\n`;

async function installStubs(
	page: Page,
	options: {
		permissionMode?: "deny" | "ask" | "allow";
		ceiling?: Record<string, "ask" | "deny">;
	} = {}
) {
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
					permissionMode: options.permissionMode ?? "ask",
				},
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
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/permission-rules?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				mode: options.permissionMode ?? "ask",
				rules: [],
				savedApprovals: [],
				ceiling: options.ceiling ?? {},
			}),
		})
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
		// The model and its effort now share one pill — the chat composer's
		// own `ModelEffortPicker` — rather than the /code-only dropdown and
		// its separate Effort pill this replaced.
		const modelEffort = page.getByRole("button", { name: "Model and effort" });
		const selector = page.getByRole("radiogroup", { name: "Permission for this session" });
		const ring = page.getByRole("button", { name: "20.2k" });
		const send = page.getByRole("button", { name: "Send message" });

		const all = [attach, mode, modelEffort, selector, ring, send];
		for (const locator of all) {
			await expect(locator).toBeVisible();
		}
		await expect(modelEffort).toContainText("Coder Large With A Rather Long Name");
		await expect(modelEffort).toContainText("High");

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

		// The selector is one pill-row-height group of three segments, not a
		// stack. Under `sm` they are chat's compact icon circles (size-8), the
		// label kept for a screen reader: the same row height as chat's toggles.
		const selectorBox = await box(selector);
		expect(selectorBox.height).toBeLessThanOrEqual(32);
		await expect(selector.getByRole("radio")).toHaveText(["Deny", "Ask", "Allow"]);

		// The model name itself truncates rather than pushing the row wider
		// (the pill's own bounding box also carries the effort suffix and
		// caret, so the truncating label span is checked directly).
		const modelLabelBox = await box(modelEffort.locator("span").first());
		expect(modelLabelBox.width).toBeLessThanOrEqual(80);

		await expect(selector.getByRole("radio", { name: "Ask" })).toHaveAttribute(
			"aria-checked",
			"true"
		);

		await page.screenshot({ path: "test-results/mobile-composer-code-390.png" });
	});

	test("the ring keeps an accessible name while going icon-only", async ({ page }) => {
		const ring = page.getByRole("button", { name: "20.2k" });

		// The name survives (matched above); the visible label is what
		// collapses — `sr-only`, not `display:none`, keeps the name intact.
		const ringLabelBox = await box(ring.locator("span").first());
		expect(ringLabelBox.width).toBeLessThan(2);
	});
});

test.describe("/code composer: the ceiling note on mobile", () => {
	test("steps aside on a phone, the row stays one line, and the Allow segment still carries it", async ({
		page,
	}) => {
		await installStubs(page, { permissionMode: "allow", ceiling: { bash: "ask" } });
		await page.setViewportSize({ width: 390, height: 844 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const selector = page.getByRole("radiogroup", { name: "Permission for this session" });
		await expect(selector).toBeVisible();
		await expect(page.getByTestId("permission-mode-note")).toBeHidden();
		await expect(selector.getByRole("radio", { name: "Allow" })).toHaveAttribute(
			"title",
			/outside the project folder/
		);
		const attach = page.getByRole("button", { name: "Add attachment" });
		const send = page.getByRole("button", { name: "Send message" });
		const [attachBox, selectorBox, sendBox] = await Promise.all([attach, selector, send].map(box));
		expect(overlapsVertically(attachBox, selectorBox)).toBe(true);
		expect(overlapsVertically(attachBox, sendBox)).toBe(true);
	});
});

test.describe("/code composer at 1280×800", () => {
	test("keeps the text labels: Deny · Ask · Allow and the ring's value", async ({ page }) => {
		await installStubs(page);
		await page.setViewportSize({ width: 1280, height: 800 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const selector = page.getByRole("radiogroup", { name: "Permission for this session" });
		const ring = page.getByRole("button", { name: "20.2k" });
		await expect(selector).toBeVisible();
		await expect(ring).toBeVisible();

		await expect(selector.getByRole("radio")).toHaveText(["Deny", "Ask", "Allow"]);
		const askBox = await box(selector.getByRole("radio", { name: "Ask" }));
		expect(askBox.width).toBeGreaterThan(20);
		const ringLabelBox = await box(ring.locator("span").first());
		expect(ringLabelBox.width).toBeGreaterThan(10);

		await page.screenshot({ path: "test-results/mobile-composer-code-desktop.png" });
	});

	test("the +, the pills, the ring and send share one row", async ({ page }) => {
		await installStubs(page);
		await page.setViewportSize({ width: 1280, height: 800 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const attach = page.getByRole("button", { name: "Add attachment" });
		const modePill = page.getByRole("button", { name: "Build" });
		const ring = page.getByRole("button", { name: "20.2k" });
		const send = page.getByRole("button", { name: "Send message" });
		const [attachBox, modeBox, ringBox, sendBox] = await Promise.all(
			[attach, modePill, ring, send].map(box)
		);
		expect(overlapsVertically(attachBox, modeBox)).toBe(true);
		expect(overlapsVertically(attachBox, ringBox)).toBe(true);
		expect(overlapsVertically(attachBox, sendBox)).toBe(true);
	});

	test("under Allow the ceiling note shows, and the row still lines up", async ({ page }) => {
		await installStubs(page, { permissionMode: "allow", ceiling: { bash: "ask" } });
		await page.setViewportSize({ width: 1280, height: 800 });
		await goto(page);
		await expect(page.getByRole("combobox")).toBeVisible();

		const selector = page.getByRole("radiogroup", { name: "Permission for this session" });
		await expect(selector).toBeVisible();
		await expect(page.getByTestId("permission-mode-note")).toHaveText(
			"Allow · bash asks (machine limit) · new subagents ask on their first turn"
		);

		// The note is one more thing in the pill row: `+` and send must stay on
		// it, not drift to the composer's corner.
		const attach = page.getByRole("button", { name: "Add attachment" });
		const send = page.getByRole("button", { name: "Send message" });
		const [attachBox, selectorBox, sendBox] = await Promise.all([attach, selector, send].map(box));
		expect(overlapsVertically(attachBox, selectorBox)).toBe(true);
		expect(overlapsVertically(attachBox, sendBox)).toBe(true);

		await page.screenshot({ path: "test-results/mobile-composer-code-desktop-allow.png" });
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

test.describe("chat composer at 1280×800", () => {
	test("keeps the model pill's text label and the tool pills' text", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${E2E_APP_BASE}/`);

		await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("Model:");
		await expect(page.getByRole("button", { name: "Web search" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Tools ask first" })).toBeVisible();

		await page.screenshot({ path: "test-results/mobile-composer-chat-desktop.png" });
	});

	test("the +, the pills and send share one row", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`${E2E_APP_BASE}/`);

		const attach = page.getByRole("button", { name: "Add attachment" });
		const webSearch = page.getByRole("button", { name: "Web search" });
		const send = page.getByRole("button", { name: "Send message" });
		const [attachBox, webBox, sendBox] = await Promise.all([attach, webSearch, send].map(box));
		expect(overlapsVertically(attachBox, webBox)).toBe(true);
		expect(overlapsVertically(attachBox, sendBox)).toBe(true);
	});
});
