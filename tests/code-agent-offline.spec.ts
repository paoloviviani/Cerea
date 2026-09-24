/**
 * Opening an agent view straight at an offline device — a bookmark, a stale
 * tab, or the machine going offline mid-session — must never ask the daemon
 * for anything (`v1/agents/:id`, `v1/workspaces`, `.../subagents`, the SSE
 * stream): each of those 502s on an unreachable machine, and the stream's
 * `EventSource` would otherwise retry on its own timer forever, warn-logging
 * the server on every attempt. Instead the view shows one clean "offline"
 * state and refuses the send, rather than the transcript sitting on "Ready
 * when you are" with no explanation.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

async function openAgentsPanel(page: Page) {
	await page.getByRole("button", { name: "Agents", exact: true }).click();
}

function deviceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: DEVICE,
		name: "e2e box",
		status: "paired",
		online: false,
		credentialState: "ok",
		backends: [],
		policy: { autoAccept: "denied", workspaceRoots: [], allowFreeModels: false },
		createdAt: new Date(),
		...overrides,
	};
}

test("an offline device's open agent shows a clean offline state and asks the daemon for nothing", async ({
	page,
}) => {
	await page.route("**/api/v2/code/devices*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ devices: [deviceRow()] }),
		})
	);

	const machineCalls: string[] = [];
	for (const pattern of [
		`**/api/v2/code/v1/agents/${AGENT}?*`,
		"**/api/v2/code/v1/workspaces?*",
		`**/api/v2/code/v1/agents/${AGENT}/subagents?*`,
		`**/api/v2/code/agents/${AGENT}/stream?*`,
	]) {
		await page.route(pattern, (route) => {
			machineCalls.push(route.request().url());
			return route.fulfill({ status: 502, body: "should never be called" });
		});
	}

	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await openAgentsPanel(page);

	await expect(page.getByText("This machine is offline.").first()).toBeVisible();
	await expect(page.getByPlaceholder("Follow up with the agent…")).toBeVisible();
	await page.getByPlaceholder("Follow up with the agent…").fill("are you there?");
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

	// Give any errant fetch a moment to land before asserting none did.
	await page.waitForTimeout(500);
	expect(machineCalls, `unexpected requests to an offline machine: ${machineCalls}`).toEqual([]);
});
