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
 *   directory, and a click flips it optimistically — the same discipline
 *   chat's own web-search and tool-approval pills use — posting
 *   `{ featureId, value }` in the background and rolling back with a toast
 *   if the daemon refuses. Unlike mode/model/effort (which stay
 *   snapshot-claimed: those change what the agent runs, so waiting for the
 *   daemon's word is the point), a feature flip does not need the whole
 *   agent snapshot re-read to know it landed — and re-reading it anyway
 *   used to flash the model/effort pill on every click, since the parent
 *   replaces the snapshot wholesale rather than patching it;
 * - a feature the snapshot is silent on renders but does not take a click:
 *   existence is known from the provider's list, a state is not;
 * - a machine policy veto (`blockedReason`) still ships the toggle, visible
 *   and disabled, carrying the re-enroll fix rather than disappearing as if
 *   the feature never existed;
 * - the approval card's three buttons post the daemon's own vocabulary:
 *   "Allow once" is `{ decision: "once" }`, "Always allow" is
 *   `{ decision: "always" }`, "Deny" is `{ decision: "reject" }`.
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

async function installStubs(
	page: Page,
	options: { snapshot?: Record<string, unknown>; featureFails?: boolean } = {}
) {
	const cancelBodies: unknown[] = [];
	const featureBodies: unknown[] = [];
	const featureQueries: string[] = [];
	const permissionBodies: unknown[] = [];
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

	// The feature flip: record the body, then answer as the daemon would. The
	// apply is optimistic now (no refetch rides on this response), but the
	// stub still updates its own snapshot so a later, unrelated refresh
	// would agree with what was already shown.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/feature?*`, async (route) => {
		const body = route.request().postDataJSON() as { featureId: string; value: boolean };
		featureBodies.push(body);
		if (options.featureFails) {
			// A small delay: the flip must be visible as claimed before the
			// refusal rolls it back, and a same-tick mocked round trip would
			// let a poll-based assertion miss that entirely.
			await new Promise((resolve) => setTimeout(resolve, 200));
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ message: "The daemon refused the feature." }),
			});
			return;
		}
		const listed = agent.features as Array<Record<string, unknown>>;
		agent.features = listed.map((feature) =>
			feature.id === body.featureId ? { ...feature, value: body.value } : feature
		);
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true }),
		});
	});

	// The approval card: record the decision the daemon's own vocabulary
	// carries verbatim (once / always / reject), answer ok. The card settles
	// from the stream's own resolved frame, never from this response.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/permissions/*?*`, async (route) => {
		permissionBodies.push(route.request().postDataJSON());
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

	return { frames, cancelBodies, featureBodies, featureQueries, permissionBodies, agent };
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

	test("Allow once posts { decision: 'once' }", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push({ type: "user", text: "Clean the build" }, running(), PERMISSION_REQUEST);
		await goto(page);

		await page.getByRole("button", { name: "Allow once" }).click();
		await expect
			.poll(() => h.permissionBodies, { timeout: 10_000 })
			.toEqual([{ decision: "once" }]);

		h.frames.push(
			{
				type: "elicitation",
				subtype: "resolved",
				elicitationId: PERMISSION_REQUEST.request.elicitationId,
				action: "accept",
				resolution: "user",
			},
			done()
		);
		await expect(page.getByText("Allowed")).toBeVisible({ timeout: 10_000 });
	});

	test("Always allow posts { decision: 'always' }", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push({ type: "user", text: "Clean the build" }, running(), PERMISSION_REQUEST);
		await goto(page);

		await expect(page.getByRole("button", { name: "Always allow" })).toBeVisible();
		await page.getByRole("button", { name: "Always allow" }).click();
		await expect
			.poll(() => h.permissionBodies, { timeout: 10_000 })
			.toEqual([{ decision: "always" }]);

		h.frames.push(
			{
				type: "elicitation",
				subtype: "resolved",
				elicitationId: PERMISSION_REQUEST.request.elicitationId,
				action: "accept",
				resolution: "user",
			},
			done()
		);
		await expect(page.getByText("Allowed")).toBeVisible({ timeout: 10_000 });
	});

	test("Deny posts { decision: 'reject' }", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push({ type: "user", text: "Clean the build" }, running(), PERMISSION_REQUEST);
		await goto(page);

		await page.getByRole("button", { name: "Deny" }).click();
		await expect
			.poll(() => h.permissionBodies, { timeout: 10_000 })
			.toEqual([{ decision: "reject" }]);

		h.frames.push(permissionDenied(), done());
		await expect(page.getByText("Denied")).toBeVisible({ timeout: 10_000 });
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
	test("reads the provider's features with the agent's cwd, and a click flips it optimistically", async ({
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

		// Claimed at once — no wait for a refreshed snapshot, unlike mode or
		// model. The default `expect` timeout is generous; the point this
		// pins is that the flip does not depend on the feature POST's
		// response landing first (`h.featureBodies` is asserted after).
		await expect(pill).toHaveAttribute("aria-pressed", "true");
		expect(h.featureBodies).toEqual([{ featureId: "auto_accept", value: true }]);
	});

	test("a refused flip rolls back and shows a toast, without touching the sibling pills", async ({
		page,
	}) => {
		const h = await installStubs(page, { featureFails: true });
		await goto(page);

		const pill = page.getByRole("button", { name: "Auto Accept" });
		const mode = page.getByRole("button", { name: "Plan" });
		await expect(pill).toHaveAttribute("aria-pressed", "false");

		await pill.click();
		await expect(pill).toHaveAttribute("aria-pressed", "true");

		// The daemon's refusal rolls the optimistic flip back and surfaces a
		// toast — the same rollback chat's own toggles use — rather than
		// leaving the pill claiming a state the server never accepted.
		await expect(page.getByText("The daemon refused the feature.")).toBeVisible();
		await expect(pill).toHaveAttribute("aria-pressed", "false");
		await expect(mode).toBeVisible();
		expect(h.featureBodies).toEqual([{ featureId: "auto_accept", value: true }]);
	});

	test("toggling auto-accept does not remount the sibling pills", async ({ page }) => {
		await installStubs(page);
		await goto(page);

		const pill = page.getByRole("button", { name: "Auto Accept" });
		const mode = page.getByRole("button", { name: "Plan" });
		const model = page.getByRole("button", { name: "Model and effort" });
		await expect(pill).toBeVisible();
		await expect(mode).toBeVisible();
		await expect(model).toBeVisible();

		// A marker written straight onto the live DOM node: a remount tears
		// the node down and builds a fresh one, which drops anything set on
		// it directly like this — a prop or text update, the healthy case,
		// never does.
		await mode.evaluate((el) => el.setAttribute("data-remount-probe", "1"));
		await model.evaluate((el) => el.setAttribute("data-remount-probe", "1"));

		await pill.click();
		await expect(pill).toHaveAttribute("aria-pressed", "true");

		await expect(mode).toHaveAttribute("data-remount-probe", "1");
		await expect(model).toHaveAttribute("data-remount-probe", "1");
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

	test("a machine policy veto keeps the toggle visible, disabled, with the re-enroll fix", async ({
		page,
	}) => {
		const VETO_NOTE =
			"This machine's policy vetoes auto-accept: re-run `galopin enroll … --allow-auto-accept`, then restart `run`.";
		const h = await installStubs(page, {
			snapshot: {
				id: AGENT,
				title: "e2e agent",
				provider: "opencode",
				state: "idle",
				workspaceId: WS,
				modeId: "plan",
				modelId: "pystino/coder-large",
				cwd: "/repo",
				features: [{ ...AUTO_ACCEPT, blockedReason: VETO_NOTE }],
			},
		});
		await goto(page);

		// Absent under the old behaviour (the catalog dropped the feature
		// entirely once policy denied it); visible and disabled now, with the
		// exact fix carried alongside it rather than left implicit.
		const pill = page.getByRole("button", { name: "Auto Accept" });
		await expect(pill).toBeVisible();
		await expect(pill).toBeDisabled();
		await expect(page.getByText(VETO_NOTE)).toBeVisible();

		await pill.click({ force: true });
		await page.waitForTimeout(300);
		expect(h.featureBodies).toEqual([]);
	});
});
