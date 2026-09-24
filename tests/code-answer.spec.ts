/**
 * Reproduction harness for the vanishing answer: the daemon emits the turn
 * (turn_started → user echo → stream tokens → turn_completed, confirmed by
 * the bridge's own trace on the live stack), the browser shows the composer
 * sent the message but no reply ever renders — just the pending dots.
 *
 * The hermetic stack has no paired daemon; the /code endpoints are stubbed at
 * the network layer instead. The stream stub replays the exact frame sequence
 * the live bridge emitted (seq 2-6 of the trace), after the snapshot frame a
 * fresh mount receives (seq 1: the idle agent's settled turn state).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

/** One SSE frame in the bridge's wire shape. */
const frame = (payload: unknown) => `event: update\ndata: ${JSON.stringify(payload)}\n\n`;

test.beforeEach(async ({ page }) => {
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
			body: superjsonBody({
				agent: {
					id: AGENT,
					title: "e2e agent",
					provider: "opencode",
					state: "idle",
					cwd: "/repo",
					workspaceId: WS,
				},
			}),
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
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ agents: [] }),
		})
	);

	// The stream stub: the snapshot's settled turn state first (a fresh
	// mount on an idle agent), then the live sequence the trace showed —
	// note the running state arrives BEFORE the user echo, exactly as the
	// daemon orders it.
	const stream = [
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		frame({ type: "turnState", state: "running", serverNow: Date.now() }),
		frame({ type: "user", text: "hello agent" }),
		frame({ type: "stream", token: "The " }),
		frame({ type: "stream", token: "answer." }),
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		"event: end\ndata: {}\n\n",
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);
});

test("the live turn's user echo and answer render without a remount", async ({ page }) => {
	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// The user echo must land as a message.
	await expect(page.getByText("hello agent")).toBeVisible();

	// The streamed answer must land too — the fold adopts the running turn,
	// the tokens render, and the dots are gone by the time the turn
	// completes.
	await expect(page.getByText("The answer.")).toBeVisible();

	// The pending placeholder (three waving dots) must not survive a
	// completed turn.
	const dots = page.locator(".message-pending, [data-pending]");
	await expect(dots).toHaveCount(0);
});
