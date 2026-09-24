/**
 * The stop control and the auto-accept toggle, hermetically: the /code
 * endpoints are stubbed at the network layer, so the client code paths are
 * the real ones.
 *
 * What is pinned here:
 *
 * - a live turn shows the stop control where chat puts its own (the send
 *   button's spot), clicking it calls the forwarder's cancel route, and the
 *   turn only ends when the transcript's stream says so — the stop's answer
 *   is a receipt, not the outcome. Mid-permission-prompt is the case that
 *   matters: the daemon resolves the outstanding request denied, the card
 *   settles ("Denied"), and no dots hang;
 * - the auto-accept toggle renders from the agent snapshot's own feature
 *   word, the provider's feature list is read with the agent's working
 *   directory, and a flip posts `{ featureId, value }` while the label only
 *   claims the new value once the refreshed snapshot agrees — the same
 *   never-an-optimistic-splice discipline the mode pill runs on;
 * - a feature the snapshot is silent on renders but does not take a click:
 *   existence is known from the provider's list, a state is not.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const AUTO_ACCEPT = {
	id: "auto_accept",
	label: "Auto Accept",
	description: "Automatically approves OpenCode tool permission prompts.",
	value: false,
};

const running = () => ({ type: "turnState", state: "running", serverNow: Date.now() });
const done = (reason?: string) => ({
	type: "turnState",
	state: "done",
	serverNow: Date.now(),
	...(reason ? { reason } : {}),
});
const PERMISSION_REQUEST = {
	type: "elicitation",
	subtype: "request",
	request: {
		elicitationId: "perm_e2e_1",
		mode: "form",
		message: "The agent wants to run a command",
		toolApproval: { tool: "rm -rf build/", args: { path: "build/" } },
	},
};
const permissionDenied = () => ({
	type: "elicitation",
	subtype: "resolved",
	elicitationId: PERMISSION_REQUEST.request.elicitationId,
	action: "decline",
	resolution: "user",
});

async function installStubs(page: Page, options: { snapshot?: Record<string, unknown> } = {}) {
	const cancelBodies: unknown[] = [];
	const featureBodies: unknown[] = [];
	const featureQueries: string[] = [];
	const frames: unknown[] = [];
	const agent: Record<string, unknown> = options.snapshot ?? {
		id: AGENT,
		title: "e2e agent",
		provider: "opencode",
		state: "idle",
		workspaceId: WS,
		modeId: "plan",
		modelId: "pystino/coder-large",
		cwd: "/repo",
		features: [{ ...AUTO_ACCEPT }],
	};

	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired" }],
			}),
		})
	);
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ agent, features: agent.features ?? [], cwd: agent.cwd }),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				workspaces: [{ id: WS, name: "repo", path: "/repo" }],
			}),
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
				models: [{ id: "pystino/coder-large", label: "Coder Large", isDefault: true }],
			}),
		})
	);

	// The provider's feature list — the toggle's existence and name. The
	// query carries the agent's working directory; record it to pin that.
	await page.route("**/api/v2/code/v1/providers/opencode/features?*", async (route) => {
		featureQueries.push(route.request().url());
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ features: [{ ...AUTO_ACCEPT }] }),
		});
	});

	// The feature flip: record the body, then answer as the daemon would, so
	// the refetch the apply triggers reports the applied state.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/feature?*`, async (route) => {
		const body = route.request().postDataJSON() as { featureId: string; value: boolean };
		featureBodies.push(body);
		const listed = agent.features as Array<Record<string, unknown>>;
		agent.features = listed.map((feature) =>
			feature.id === body.featureId ? { ...feature, value: body.value } : feature
		);
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true }),
		});
	});

	// The stop: record the body, answer ok. The turn's end travels on the
	// stream, never on this response.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/cancel?*`, async (route) => {
		cancelBodies.push(route.request().postDataJSON());
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true }),
		});
	});

	// The transcript stream. A stubbed SSE endpoint cannot hold a response
	// open, so the stub mimics the bridge's own replay contract instead —
	// with one harness-mandated difference: Playwright-fulfilled responses
	// do not persist lastEventId across the synthetic reconnect (a bare
	// EventSource replays the full list every 250ms and never sends
	// Last-Event-ID — verified with a bare-source probe), so the resume
	// cursor lives server-side here: each response carries only frames the
	// browser has not seen yet. The fold reads one iterator across all of
	// it, exactly as it does across a real bridge's reconnects.
	let served = 0;
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, async (route) => {
		const body =
			"retry: 250\n\n" +
			frames
				.slice(served)
				.map(
					(update, i) => `id: ${served + i + 1}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`
				)
				.join("");
		served = frames.length;
		await route.fulfill({ status: 200, contentType: "text/event-stream", body });
	});

	return { frames, cancelBodies, featureBodies, featureQueries, agent };
}

const goto = (page: Page) =>
	page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

test.describe("the stop control", () => {
	test("a live turn shows it; stopping ends the turn when the stream says so", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push({ type: "user", text: "Run the tests" }, running(), {
			type: "stream",
			token: "Working on it…",
		});
		await goto(page);

		// The turn is live: the send button's spot carries the stop control,
		// chat's own swap.
		const stop = page.getByRole("button", { name: "Stop generating" });
		await expect(stop).toBeVisible();
		await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);

		await stop.click();
		await expect.poll(() => h.cancelBodies, { timeout: 10_000 }).toEqual([{}]);

		// The answer is a receipt: the turn is still live until the stream's
		// terminal frame lands. Then the send button returns — no dots hang.
		await expect(stop).toBeVisible();
		h.frames.push(done("interrupted"));
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	});

	test("stopping mid-permission-prompt settles the card", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push({ type: "user", text: "Clean the build" }, running(), PERMISSION_REQUEST);
		await goto(page);

		// The prompt is up and the turn is live behind it — the stop control
		// is exactly for this state.
		await expect(page.getByText("wants to call")).toBeVisible();
		const stop = page.getByRole("button", { name: "Stop generating" });
		await expect(stop).toBeVisible();

		await stop.click();
		await expect.poll(() => h.cancelBodies, { timeout: 10_000 }).toEqual([{}]);

		// The daemon resolves the outstanding request denied (its own cancel
		// behaviour) and ends the turn; the card settles through the fold's
		// resolution path and the dots stop.
		h.frames.push(permissionDenied(), done("interrupted"));
		await expect(page.getByText("Denied")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
	});
});

test.describe("the auto-accept toggle", () => {
	test("reads the provider's features with the agent's cwd, flips live, claims on snapshot", async ({
		page,
	}) => {
		const h = await installStubs(page);
		await goto(page);

		// The pill renders from the snapshot's word: off, pressable.
		const pill = page.getByRole("button", { name: "Auto Accept" });
		await expect(pill).toBeVisible();
		await expect(pill).toHaveAttribute("aria-pressed", "false");

		// The feature list was read, with the working directory the daemon
		// resolves features per.
		await expect.poll(() => h.featureQueries.length, { timeout: 10_000 }).toBeGreaterThan(0);
		expect(h.featureQueries.some((url) => url.includes("cwd=%2Frepo"))).toBe(true);

		await pill.click();
		await expect
			.poll(() => h.featureBodies, { timeout: 10_000 })
			.toEqual([{ featureId: "auto_accept", value: true }]);

		// The label claims the new value only when the refreshed snapshot
		// agrees — the apply itself never flips anything locally.
		await expect(pill).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
	});

	test("a feature the snapshot is silent on renders but does not take a click", async ({
		page,
	}) => {
		await installStubs(page, {
			snapshot: {
				id: AGENT,
				title: "e2e agent",
				provider: "opencode",
				state: "idle",
				workspaceId: WS,
				modeId: "plan",
				modelId: "pystino/coder-large",
				cwd: "/repo",
				// The provider lists the toggle, the agent reports none.
				features: [],
			},
		});
		await goto(page);

		const pill = page.getByRole("button", { name: "Auto Accept" });
		await expect(pill).toBeVisible();
		await expect(pill).toBeDisabled();
	});
});
