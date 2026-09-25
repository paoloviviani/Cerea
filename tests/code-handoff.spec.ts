/**
 * The fork handoff (parity plan §4.2(a)), hermetically: the /code endpoints
 * are stubbed at the network layer, so the client code paths — the "Hand
 * off…" action, the dialog's prefill, the POST body, and the post-handoff
 * navigation — are the real ones, without a paired machine.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";
const NEW_AGENT = "agent_e2e_handoff";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const MODES = [
	{ id: "plan", label: "Plan" },
	{ id: "build", label: "Build" },
];

const MODELS = [
	{ id: "pystino/coder-large", label: "Coder Large", isDefault: true },
	{ id: "pystino/coder-flash", label: "Coder Flash" },
];

let handoffBodies: unknown[] = [];

test.beforeEach(async ({ page }) => {
	handoffBodies = [];

	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired", online: true }],
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
					workspaceId: WS,
					modeId: "plan",
					modelId: "pystino/coder-large",
					updatedAt: new Date().toISOString(),
				},
				features: [],
				cwd: "/repo",
			}),
		})
	);
	await page.route(`**/api/v2/code/v1/agents/${NEW_AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: {
					id: NEW_AGENT,
					title: "Fork: e2e agent",
					provider: "opencode",
					state: "idle",
					workspaceId: WS,
					modeId: "plan",
					modelId: "pystino/coder-large",
					updatedAt: new Date().toISOString(),
				},
				features: [],
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
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/subagents?*`, (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ subagents: [] }) })
	);
	await page.route(`**/api/v2/code/v1/agents/${NEW_AGENT}/subagents?*`, (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ subagents: [] }) })
	);

	// The dialog's own live lists — read for whichever device is currently
	// selected as the target, the source by default.
	await page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ modes: MODES }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ models: MODELS }) })
	);

	await page.route(`**/api/v2/code/v1/agents/${AGENT}/handoff?*`, async (route) => {
		const body = route.request().postDataJSON();
		handoffBodies.push(body);
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: {
					id: NEW_AGENT,
					title: "Fork: e2e agent",
					provider: "opencode",
					state: "idle",
					workspaceId: WS,
					modeId: "plan",
					modelId: "pystino/coder-large",
					updatedAt: new Date().toISOString(),
				},
				deviceId: DEVICE,
			}),
		});
	});

	// One completed turn, with a boundary marker on each side (spec §7's
	// `message` event) — what lets the dialog's "carry up to here" name a
	// point in the machine's own transcript (`Message.machineMessageId`).
	const frames = [
		{ type: "messageBoundary", role: "user", messageId: "wire-u1" },
		{ type: "user", text: "please refactor this" },
		{ type: "messageBoundary", role: "assistant", messageId: "wire-a1" },
		{ type: "stream", token: "Sure thing." },
		{ type: "turnState", state: "done", serverNow: Date.now() },
	];
	let served = 0;
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) => {
		const pending = frames.slice(served);
		served = frames.length;
		const body =
			"retry: 250\n\n" +
			pending.map((update) => `event: update\ndata: ${JSON.stringify(update)}\n\n`).join("");
		return route.fulfill({ status: 200, contentType: "text/event-stream", body });
	});
	await page.route(`**/api/v2/code/agents/${NEW_AGENT}/stream?*`, (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 250\n\n" })
	);
});

test("hands off a completed reply to a new session, carrying the history up to it", async ({
	page,
}) => {
	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);

	await expect(page.getByText("Sure thing.")).toBeVisible();

	const handoffAction = page.getByRole("button", { name: "Fork from here" });
	await expect(handoffAction).toBeVisible();
	await handoffAction.click();

	// The dialog opened, prefilled from the source.
	const dialogTitle = page.getByRole("heading", { name: "Fork from here" });
	await expect(dialogTitle).toBeVisible();
	await expect(page.getByText("From e2e agent")).toBeVisible();
	await expect(page.getByLabel("Carry the conversation up to here")).toBeChecked();

	await page.getByLabel("Prompt").fill("keep going on this");
	await page.getByRole("button", { name: "Fork", exact: true }).click();

	await expect.poll(() => handoffBodies.length).toBe(1);
	expect(handoffBodies[0]).toMatchObject({
		prompt: "keep going on this",
		carry: true,
		workspaceId: WS,
		modeId: "plan",
		modelId: "pystino/coder-large",
		uptoMessageId: "wire-a1",
	});
	// Same device as the source: no targetDevice field at all.
	expect(handoffBodies[0]).not.toHaveProperty("targetDevice");

	// Navigated to the new session, whose header names its source by title.
	await page.waitForURL(`**/code?device=${DEVICE}&ws=${WS}&agent=${NEW_AGENT}`);
	await expect(page.getByText("Forked from e2e agent")).toBeVisible();
});

test("carrying can be turned off, and the prompt is required", async ({ page }) => {
	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await expect(page.getByText("Sure thing.")).toBeVisible();

	await page.getByRole("button", { name: "Fork from here" }).click();
	const submit = page.getByRole("button", { name: "Fork", exact: true });

	// Nothing typed yet: the dialog refuses to submit.
	await expect(submit).toBeDisabled();

	await page.getByLabel("Carry the conversation up to here").uncheck();
	await page.getByLabel("Prompt").fill("start fresh");
	await submit.click();

	await expect.poll(() => handoffBodies.length).toBe(1);
	expect(handoffBodies[0]).toMatchObject({ prompt: "start fresh", carry: false });
	expect(handoffBodies[0]).not.toHaveProperty("uptoMessageId");
});
