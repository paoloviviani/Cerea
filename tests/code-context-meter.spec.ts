/**
 * The context/usage meter (M3), hermetically: the /code endpoints are
 * stubbed at the network layer, so the client fold and the forwarder route
 * shapes are the real ones — no paired machine involved.
 *
 * What is pinned here: the ring shows a percentage once a `usage` frame
 * names a max, and a raw token count when it does not; the popover carries
 * the input/output/cache breakdown and the last compaction; "Compact now"
 * calls the forwarder's compact route; and the whole meter is absent when
 * the device's backend does not advertise the `usage` capability.
 */
import { test, expect } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

/** One SSE frame in the bridge's wire shape — the client's own
 * `AgentStreamUpdate` JSON, exactly as `codeAgentStream.ts` parses it. */
const frame = (payload: unknown) => `event: update\ndata: ${JSON.stringify(payload)}\n\n`;

const BACKEND_WITH_USAGE = {
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
	},
};

const BACKEND_NO_USAGE = {
	...BACKEND_WITH_USAGE,
	capabilities: { ...BACKEND_WITH_USAGE.capabilities, usage: false },
};

function routeCommon(page: import("playwright/test").Page, backends: unknown[]) {
	return Promise.all([
		page.route("**/api/v2/code/devices", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					devices: [{ id: DEVICE, name: "e2e box", status: "paired", backends }],
				}),
			})
		),
		page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
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
		),
		page.route("**/api/v2/code/v1/workspaces?*", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ workspaces: [{ id: WS, name: "repo", path: "/repo" }] }),
			})
		),
		page.route("**/api/v2/code/v1/agents?*", (route) =>
			route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
		),
		page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
			route.fulfill({ contentType: "application/json", body: superjsonBody({ modes: [] }) })
		),
		page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
			route.fulfill({ contentType: "application/json", body: superjsonBody({ models: [] }) })
		),
	]);
}

test("the meter shows a percentage and its popover carries the breakdown", async ({ page }) => {
	await routeCommon(page, [BACKEND_WITH_USAGE]);
	const stream = [
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		frame({
			type: "usage",
			usage: { used: 400, max: 1000, input: 300, output: 80, cacheRead: 20, reasoning: 0 },
		}),
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	const trigger = page.getByRole("button", { name: "40%" });
	await expect(trigger).toBeVisible();

	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByText("400 / 1000 tokens")).toBeVisible();
	await expect(menu.getByText("300", { exact: true })).toBeVisible();
});

test("the meter shows a raw token count when no max is known", async ({ page }) => {
	await routeCommon(page, [BACKEND_WITH_USAGE]);
	const stream = [
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		frame({ type: "usage", usage: { used: 1234, input: 1000, output: 234 } }),
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// No invented maximum: a bare token count, never a percentage.
	await expect(page.getByRole("button", { name: "1.2k" })).toBeVisible();
});

test("Compact now calls the forwarder's compact route and the popover reflects it", async ({
	page,
}) => {
	await routeCommon(page, [BACKEND_WITH_USAGE]);
	const stream = [
		frame({ type: "turnState", state: "done", serverNow: Date.now() }),
		frame({ type: "usage", usage: { used: 900, max: 1000 } }),
		frame({ type: "compaction", auto: false }),
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);

	let compactCalls = 0;
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/compact?*`, async (route) => {
		compactCalls += 1;
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	const trigger = page.getByRole("button", { name: "90%" });
	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(menu.getByText("Compacted manually")).toBeVisible();

	await menu.getByRole("button", { name: "Compact now" }).click();
	await expect.poll(() => compactCalls).toBe(1);
});

test("a new message that has not reported usage yet does not drop the meter to 0", async ({
	page,
}) => {
	await routeCommon(page, [BACKEND_WITH_USAGE]);
	// A finished turn at 40%, then the next turn starts: opencode's new assistant
	// message carries zero tokens until its step ends.
	const stream = [
		frame({ type: "usage", usage: { used: 400, max: 1000 } }),
		frame({ type: "turnState", state: "running", serverNow: Date.now() }),
		frame({ type: "usage", usage: { used: 0, max: 1000, input: 0, output: 0 } }),
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);
	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await expect(page.getByRole("button", { name: "40%" })).toBeVisible();
	await expect(page.getByRole("button", { name: "0%" })).toHaveCount(0);
});

test("the meter is hidden when the backend has no usage capability", async ({ page }) => {
	await routeCommon(page, [BACKEND_NO_USAGE]);
	const stream = [frame({ type: "turnState", state: "done", serverNow: Date.now() })].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// The composer itself is there (mode/model pills render); the meter never
	// appears, capability absent regardless of what usage frames might say.
	// `exact: true`, because "Mode" is otherwise a substring match of "Model" too.
	await expect(page.getByRole("button", { name: "Mode", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /^\d+%$/ })).toHaveCount(0);
});
