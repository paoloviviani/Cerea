/**
 * Agent asks outside /code: the app-wide Needs-you bar, the asks pinned above the composer of the
 * chat that started the session, and the sidebar badge.
 *
 * Hermetic like code-answer.spec.ts: the machine side of /code is stubbed at the network layer
 * (a stateful pending list, answered through the reply route), the conversation is a real stored
 * one carrying an `agentSession` update, so the chat page, its composer and the shell are real.
 */
import superjson from "superjson";
import { test, expect, E2E_APP_BASE } from "./fixtures";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const MINE = "agent_from_chat";
const OTHER = "agent_elsewhere";

const body = (data: unknown) => superjson.stringify(data);
const ask = (sessionId: string, id: string, title: string) => ({
	sessionId,
	workspaceId: WS,
	sessionTitle: title,
	request: {
		id,
		sessionId,
		tool: "bash",
		title: `Run ${title}`,
		patterns: [],
		metadata: {},
		always: [],
	},
});

test("asks show on every page, pinned above the composer of the chat that started the session", async ({
	page,
	seedConversation,
}) => {
	const pending = [ask(MINE, "perm-mine", "chat-started"), ask(OTHER, "perm-other", "elsewhere")];
	const replies: string[] = [];
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: body({ devices: [{ id: DEVICE, name: "e2e box", status: "paired", online: true }] }),
		})
	);
	await page.route("**/api/v2/code/v1/permissions/pending?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: body({ permissions: pending, questions: [] }),
		})
	);
	await page.route("**/api/v2/code/v1/agents/*/permissions/*?*", (route) => {
		const id = route.request().url().split("/permissions/")[1].split("?")[0];
		replies.push(id);
		const at = pending.findIndex((p) => p.request.id === id);
		if (at >= 0) pending.splice(at, 1);
		return route.fulfill({ contentType: "application/json", body: body({ ok: true }) });
	});
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: body({ agents: [] }) })
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({ contentType: "application/json", body: body({ workspaces: [] }) })
	);
	await page.route("**/api/v2/code/agents/*/stream?*", (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" })
	);

	const conversationId = await seedConversation({
		title: "Chat with an agent",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "start an agent" },
			{
				from: "assistant",
				content: "Started it.",
				extra: {
					updates: [
						{
							type: "agentSession",
							action: "started",
							deviceId: DEVICE,
							workspaceId: WS,
							sessionId: MINE,
							title: "chat-started",
							labels: { device: "e2e box", workspace: "repo" },
						},
					],
				},
			},
		],
	});

	// Another page: the app-wide bar, collapsed, then opened; the sidebar badge counts both.
	await page.goto(`${E2E_APP_BASE}/projects`);
	const bar = page.getByTestId("needs-you-inbox");
	await expect(bar).toContainText("2 need you", { timeout: 30_000 });
	await expect(page.getByTestId("needs-you-item")).toHaveCount(0);
	await expect(page.getByTestId("sidebar-agents-badge").first()).toHaveText("2");
	await expect(page.getByRole("button", { name: "Agents, 2 need you" }).first()).toBeAttached();

	// The chat that started MINE: its ask is pinned above the composer, open; the bar keeps the other.
	await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
	const pinned = page.getByTestId("needs-you-pinned");
	await expect(pinned).toBeVisible({ timeout: 30_000 });
	await expect(pinned.getByTestId("needs-you-item")).toHaveCount(1);
	await expect(pinned).toContainText("chat-started");
	await expect(bar).toContainText("1 needs you");
	const composer = page.getByPlaceholder("Ask anything");
	const above = await pinned.evaluate((el, sel) => {
		const form = document.querySelector(sel);
		return !!form && !!(el.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
	}, "form");
	expect(above).toBe(true);
	await expect(composer).toBeVisible();

	// Answering there resolves it on the machine, and the page is left with the other one only.
	await pinned.getByRole("button", { name: "Allow once" }).click();
	await expect.poll(() => replies).toEqual(["perm-mine"]);
	await expect(pinned).toHaveCount(0);
	await expect(bar).toContainText("1 needs you");

	// /code draws its own inbox, never a second one from the shell.
	await page.goto(`${E2E_APP_BASE}/code`);
	await expect(page.getByTestId("needs-you-inbox")).toHaveCount(1);
});
