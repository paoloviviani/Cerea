/**
 * Reproduction harness for subagent tracking: a turn whose provider spawns
 * a subagent (opencode's Task tool) must show the subagent anchored at its
 * tool call — title/status/subtitle from the daemon's roster — with an
 * expandable transcript, without a remount and without interval polling.
 *
 * The hermetic stack has no paired daemon; the /code endpoints are stubbed
 * at the network layer. The roster is served once (the view polls it on
 * turn boundaries); the subagent timeline is served on expansion.
 */
import { test, expect } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";
const SUB = "ses_sub1";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const taskCall = {
	type: "tool",
	subtype: "call",
	uuid: "call_task1",
	call: { name: "task", parameters: { description: "Explore the repo layout" } },
};
const taskResult = {
	type: "tool",
	subtype: "result",
	uuid: "call_task1",
	result: {
		status: "success",
		call: { name: "task", parameters: { description: "Explore the repo layout" } },
		outputs: [{ text: "done" }],
		display: true,
	},
};

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
	// The roster, polled on turn boundaries: one completed subagent
	// anchored at the Task tool call below.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/subagents?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				subagents: [
					{
						id: SUB,
						parentAgentId: AGENT,
						parentSubagentId: null,
						provider: "opencode",
						title: "explore",
						description: "Explore the repo layout",
						status: "completed",
						createdAt: "2026-09-23T08:46:20.823Z",
						updatedAt: "2026-09-23T08:46:58.240Z",
						toolCallId: "call_task1",
						cwd: "/repo",
						subtitle: "explore · test-model · 1.0k tokens",
					},
				],
			}),
		})
	);
	// The subagent's own transcript, fetched on expansion.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/subagents/${SUB}/timeline?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				updates: [
					{ type: "user", text: "explore the repo" },
					{ type: "stream", token: "The repo has three packages." },
					{ type: "turnState", state: "done", serverNow: Date.now() },
				],
			}),
		})
	);

	// Server-side cursor (see code-stop-auto.spec.ts): Playwright-fulfilled
	// SSE responses do not persist lastEventId across synthetic reconnects,
	// so each response carries only frames not yet sent.
	let served = 0;
	const frames = [
		{ type: "turnState", state: "done", serverNow: Date.now() },
		{ type: "turnState", state: "running", serverNow: Date.now() },
		{ type: "user", text: "map the repo" },
		taskCall,
		{ type: "stream", token: "On it." },
		taskResult,
		{ type: "turnState", state: "done", serverNow: Date.now() },
		"event: end\ndata: {}\n\n",
	];
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) => {
		const pending = frames.slice(served);
		served = frames.length;
		const body =
			"retry: 250\n\n" +
			pending
				.map((update) =>
					typeof update === "string" ? update : `event: update\ndata: ${JSON.stringify(update)}\n\n`
				)
				.join("");
		return route.fulfill({ status: 200, contentType: "text/event-stream", body });
	});
});

test("a spawned subagent anchors at its task call with an expandable transcript", async ({
	page,
}) => {
	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// The roster pairs the Task call: the card carries the subagent's title
	// and subtitle instead of the generic tool row.
	await expect(page.getByText("explore", { exact: true }).first()).toBeVisible();
	await expect(page.getByText(/1\.0k tokens/)).toBeVisible();

	// Expanding fetches the subagent timeline once and folds it through the
	// same consumer — the nested transcript reads like the parent's.
	await page.getByText("explore", { exact: true }).first().click();
	await expect(page.getByText("The repo has three packages.")).toBeVisible();
});
