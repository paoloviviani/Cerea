/**
 * The sidebar's Chats/Agents switch, hermetically: reloading on an agent
 * session URL must open the sidebar on Agents, not Chats — the /code
 * endpoints are stubbed at the network layer, so the route-derived default
 * in NavMenu (`effectiveView`) is exercised through the real client code
 * path, the same pattern code-kebab-layout.spec.ts and code-answer.spec.ts
 * use.
 */
import { test, expect } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";
const AGENT_TITLE = "e2e-restore-agent";

const superjsonBody = (data: unknown) => superjson.stringify(data);

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
					title: AGENT_TITLE,
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
			body: superjsonBody({ workspaces: [{ id: WS, name: "repo", path: "/repo" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agents: [
					{
						id: AGENT,
						title: AGENT_TITLE,
						provider: "opencode",
						state: "idle",
						cwd: "/repo",
						workspaceId: WS,
					},
				],
			}),
		})
	);

	// An idle-turn snapshot: the agent screen mounts without needing a live
	// stream for this spec, which only cares about the sidebar's own switch.
	const stream = [
		`event: update\ndata: ${JSON.stringify({ type: "turnState", state: "done", serverNow: Date.now() })}\n\n`,
		"event: end\ndata: {}\n\n",
	].join("");
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: stream })
	);
});

test("loading an agent session URL directly opens the sidebar on Agents", async ({ page }) => {
	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	// The switch itself reads as Agents-selected — scoped by testid, not role
	// name, because the chat tree's own "Chats" branch header is also a
	// same-named button once the chat list is showing.
	const agentsPill = page.getByTestId("sidebar-view-agents").first();
	const chatsPill = page.getByTestId("sidebar-view-chats").first();
	await expect(agentsPill).toHaveClass(/bg-white/);
	await expect(chatsPill).not.toHaveClass(/bg-white/);

	// ...and the paired device's tree is what actually renders in the list,
	// not the chat list.
	await expect(page.getByText("e2e box")).toBeVisible();
	await expect(page.getByRole("button", { name: "Pair", exact: true })).toBeVisible();
});

test("the person can still switch to Chats after an agent reload", async ({
	page,
	seedConversation,
}) => {
	await seedConversation({ title: "a restored chat row" });

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await expect(page.getByText("e2e box")).toBeVisible();

	await page.getByTestId("sidebar-view-chats").first().click();

	await expect(page.getByText("a restored chat row")).toBeVisible();
	const agentsPill = page.getByTestId("sidebar-view-agents").first();
	const chatsPill = page.getByTestId("sidebar-view-chats").first();
	await expect(chatsPill).toHaveClass(/bg-white/);
	await expect(agentsPill).not.toHaveClass(/bg-white/);
});

test("loading a chat route opens the sidebar on Chats, unaffected by the /code default", async ({
	page,
	seedConversation,
}) => {
	await seedConversation({ title: "an ordinary chat row" });

	await page.goto("/");

	await expect(page.getByText("an ordinary chat row")).toBeVisible();
	const chatsPill = page.getByTestId("sidebar-view-chats").first();
	await expect(chatsPill).toHaveClass(/bg-white/);
});
