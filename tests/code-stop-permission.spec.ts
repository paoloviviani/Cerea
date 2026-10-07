/**
 * The stop control and the permission selector, hermetically: the /code
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
 * - the permission selector (Deny · Ask · Allow) renders from the agent
 *   snapshot's `permissionMode` — the machine's word, never an optimistic
 *   guess: a click posts `{ mode }` and the segment moves only when the
 *   re-read snapshot says so. A refusal leaves the old word standing, a
 *   subagent's view disables it, and under Allow it names what the machine's
 *   ceiling still caps (from `permission.rules`). The write is its own route
 *   (`permission-mode`), so changing it does not remount the sibling pills;
 * - the approval card's buttons post the daemon's own vocabulary: "Allow once"
 *   is `{ decision: "once" }`, "Always allow (this session)" is
 *   `{ decision: "always" }` — and is not offered at all for a key the
 *   ceiling caps — and "Deny" is `{ decision: "reject" }`.
 *
 * MOCK: `permissionMode`, the ceiling and the `permission-mode` answer are the
 * panel's reading of the frozen contract with the agent half
 * (feat/permission-selector-agent), not galopin's behaviour.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

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
	options: {
		snapshot?: Record<string, unknown>;
		modeFails?: boolean;
		ceiling?: Record<string, "ask" | "deny">;
	} = {}
) {
	const cancelBodies: unknown[] = [];
	const modeBodies: unknown[] = [];
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
		permissionMode: "ask",
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
			body: superjsonBody({ agent, cwd: agent.cwd }),
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

	// What the machine says is in force: the session's mode and its ceiling.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/permission-rules?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				mode: agent.permissionMode,
				rules: [],
				savedApprovals: [],
				ceiling: options.ceiling ?? {},
			}),
		})
	);

	// The selector's write: record the body, then answer as the machine would
	// (and, once it has, report the new word in the snapshot a re-read gets).
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/permission-mode?*`, async (route) => {
		const body = route.request().postDataJSON() as { mode: string };
		modeBodies.push(body);
		if (options.modeFails) {
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ message: "a subagent follows its root" }),
			});
			return;
		}
		agent.permissionMode = body.mode;
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

	return { frames, cancelBodies, modeBodies, permissionBodies, agent };
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

		await expect(page.getByRole("button", { name: "Always allow (this session)" })).toBeVisible();
		await page.getByRole("button", { name: "Always allow (this session)" }).click();
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

test.describe("the permission selector", () => {
	const segment = (page: Page, mode: string) => page.getByTestId(`permission-mode-${mode}`);

	test("shows the machine's word, and a click posts { mode } and moves only when the snapshot does", async ({
		page,
	}) => {
		const h = await installStubs(page);
		await goto(page);

		await expect(segment(page, "ask")).toHaveAttribute("aria-checked", "true");
		await expect(segment(page, "allow")).toHaveAttribute("aria-checked", "false");

		await segment(page, "allow").click();
		await expect.poll(() => h.modeBodies, { timeout: 10_000 }).toEqual([{ mode: "allow" }]);
		// The composer re-read the snapshot, which now carries the new word.
		await expect(segment(page, "allow")).toHaveAttribute("aria-checked", "true");
		await expect(segment(page, "ask")).toHaveAttribute("aria-checked", "false");
	});

	test("a refusal keeps the machine's old word standing and shows its reason", async ({ page }) => {
		const h = await installStubs(page, { modeFails: true });
		await goto(page);

		await segment(page, "deny").click();
		await expect.poll(() => h.modeBodies, { timeout: 10_000 }).toEqual([{ mode: "deny" }]);
		await expect(page.getByText("a subagent follows its root")).toBeVisible();
		await expect(segment(page, "ask")).toHaveAttribute("aria-checked", "true");
		await expect(segment(page, "deny")).toHaveAttribute("aria-checked", "false");
	});

	test("changing it does not remount the sibling pills", async ({ page }) => {
		await installStubs(page);
		await goto(page);

		const mode = page.getByRole("button", { name: "Plan" });
		const model = page.getByRole("button", { name: "Model and effort" });
		await expect(mode).toBeVisible();
		await expect(model).toBeVisible();
		await mode.evaluate((el) => el.setAttribute("data-remount-probe", "1"));
		await model.evaluate((el) => el.setAttribute("data-remount-probe", "1"));

		await segment(page, "allow").click();
		await expect(segment(page, "allow")).toHaveAttribute("aria-checked", "true");

		await expect(mode).toHaveAttribute("data-remount-probe", "1");
		await expect(model).toHaveAttribute("data-remount-probe", "1");
	});

	test("under Allow it names what the machine's ceiling still caps", async ({ page }) => {
		await installStubs(page, {
			ceiling: { bash: "ask" },
			snapshot: {
				id: AGENT,
				title: "e2e agent",
				provider: "opencode",
				state: "idle",
				workspaceId: WS,
				modeId: "plan",
				modelId: "pystino/coder-large",
				cwd: "/repo",
				permissionMode: "allow",
			},
		});
		await goto(page);

		await expect(page.getByTestId("permission-mode-note")).toHaveText(
			"Allow · bash asks (machine limit)"
		);
	});

	test("a subagent's view shows its root's word, disabled, and says it follows the main session", async ({
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
				parentId: "root_e2e",
				permissionMode: "deny",
			},
		});
		await goto(page);

		await expect(segment(page, "deny")).toHaveAttribute("aria-checked", "true");
		await expect(segment(page, "allow")).toBeDisabled();
		await expect(page.getByTestId("permission-mode-note")).toHaveText("Follows the main session");
	});

	test("there is no Auto Accept pill any more", async ({ page }) => {
		await installStubs(page);
		await goto(page);
		await expect(segment(page, "ask")).toBeVisible();
		await expect(page.getByRole("button", { name: /auto.?accept/i })).toHaveCount(0);
	});

	test("the card hides Always allow for a key the ceiling caps, and offers it for another", async ({
		page,
	}) => {
		const h = await installStubs(page, { ceiling: { bash: "ask" } });
		h.frames.push({ type: "user", text: "Run it" }, running(), {
			...PERMISSION_REQUEST,
			request: {
				...PERMISSION_REQUEST.request,
				elicitationId: "perm_bash",
				toolApproval: { tool: "bash", args: { command: "ls" } },
			},
		});
		await goto(page);

		await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Always allow (this session)" })).toHaveCount(0);
	});
});
