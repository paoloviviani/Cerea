/**
 * The composer's `/` menu, hermetically: the /code endpoints are stubbed at
 * the network layer, so the client code paths are the real ones — the same
 * harness the stop/auto-accept specs use.
 *
 * What is pinned here: `/` opens the menu of panel commands; filtering and
 * arrow keys move through it; Tab/Enter accept into the draft; a submitted
 * command runs its existing route (`/compact` compacts, `/undo` opens the
 * same rollback confirmation the transcript's retry uses, `/model` with no
 * argument opens the model/effort picker); an unknown `/foo` — and the `//`
 * escape — still go out as ordinary text; the menu yields to the mode pill;
 * and on a narrow viewport the menu floats above the send/stop overlay
 * rather than under it.
 *
 * The run is refused while a turn is live (send is hidden then; steering is
 * a later wave), which the last test pins from the other side: the menu
 * itself still opens and accepts while running.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

const MODES = [
	{ id: "plan", label: "Plan", description: "Proposes; asks before it writes." },
	{ id: "build", label: "Build", description: "May edit files." },
];

const MODELS = [
	{
		id: "pystino/coder-large",
		label: "Coder Large",
		isDefault: true,
		efforts: ["low", "high"],
	},
	{ id: "pystino/coder-flash", label: "Coder Flash" },
];

interface Harness {
	compactBodies: unknown[];
	revertBodies: unknown[];
	unrevertBodies: unknown[];
	messageBodies: unknown[];
	modeBodies: unknown[];
	modelBodies: unknown[];
	commandBodies: unknown[];
	commandList: { body: unknown; status: number };
	frames: unknown[];
	agent: Record<string, unknown>;
}

/** The backend commands the stubbed listing answers with, overridable per
 * test before `goto` — a test assigns `h.commandList.body/.status`. */
const commandListStub: { body: unknown; status: number } = { body: [], status: 200 };

async function installStubs(page: Page): Promise<Harness> {
	const h: Harness = {
		compactBodies: [],
		revertBodies: [],
		unrevertBodies: [],
		messageBodies: [],
		modeBodies: [],
		modelBodies: [],
		commandBodies: [],
		commandList: commandListStub,
		frames: [],
		agent: {
			id: AGENT,
			title: "e2e agent",
			provider: "opencode",
			state: "idle",
			cwd: "/repo",
			workspaceId: WS,
			modeId: "plan",
			modelId: "pystino/coder-large",
		},
	};

	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [
					{
						id: DEVICE,
						name: "e2e box",
						status: "paired",
						// The `/` menu's capability gates read these: compact and
						// revert must be reported or their commands never list.
						backends: [
							{
								id: "opencode",
								version: "1.18.32",
								capabilities: {
									diff: true,
									children: true,
									usage: true,
									compact: true,
									images: true,
									files: true,
									worktrees: false,
									autoAccept: true,
									questions: true,
									revert: true,
									revertFiles: true,
									efforts: true,
								},
							},
						],
					},
				],
			}),
		})
	);
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ agent: h.agent, features: [], cwd: "/repo" }),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				workspaces: [{ id: WS, name: "repo", path: "/repo", isGitRepo: true }],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ modes: MODES }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ models: MODELS }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/features?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ features: [] }) })
	);

	// The menu's backend half: empty by default so the panel-only tests stay
	// quiet; a test overrides `h.commandList` before navigating.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/commands?*`, (route) =>
		route.fulfill({
			status: commandListStub.status,
			contentType: "application/json",
			body:
				commandListStub.status === 200
					? superjsonBody(commandListStub.body)
					: JSON.stringify({ message: commandListStub.body }),
		})
	);

	// The transcript stream. The same server-side cursor the stop spec uses:
	// each response carries only frames the browser has not seen yet.
	let served = 0;
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, async (route) => {
		const body =
			"retry: 250\n\n" +
			h.frames
				.slice(served)
				.map(
					(update, i) => `id: ${served + i + 1}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`
				)
				.join("");
		served = h.frames.length;
		await route.fulfill({ status: 200, contentType: "text/event-stream", body });
	});

	// The command routes: record, answer ok.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/compact?*`, async (route) => {
		h.compactBodies.push(route.request().postDataJSON());
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/revert?*`, async (route) => {
		h.revertBodies.push(route.request().postDataJSON());
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/unrevert?*`, async (route) => {
		h.unrevertBodies.push(route.request().postDataJSON());
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/mode?*`, async (route) => {
		const body = route.request().postDataJSON() as { modeId: string };
		h.modeBodies.push(body);
		h.agent = { ...h.agent, modeId: body.modeId };
		await route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ ok: true, notice: null }),
		});
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/model?*`, async (route) => {
		const body = route.request().postDataJSON() as { modelId: string };
		h.modelBodies.push(body);
		h.agent = { ...h.agent, modelId: body.modelId };
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/command?*`, async (route) => {
		h.commandBodies.push(route.request().postDataJSON());
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});

	// The ordinary send: an unknown `/foo` must land here, as text.
	await page.route(`**/api/v2/code/v1/agents/${AGENT}/messages?*`, async (route) => {
		h.messageBodies.push(route.request().postDataJSON());
		await route.fulfill({ contentType: "application/json", body: superjsonBody({ ok: true }) });
	});

	return h;
}

const goto = async (page: Page) => {
	// The capabilities that gate the panel command list ride the devices
	// fetch; typing before it lands would snapshot an ungated menu. The stub
	// answers instantly — this only synchronizes the fetch.
	const devices = page.waitForResponse(
		(response) =>
			response.url().includes("/api/v2/code/devices") && response.request().method() === "GET"
	);
	await page.goto(`${E2E_APP_BASE}/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await devices;
};

const box = (page: Page) => page.getByRole("combobox");
const menu = (page: Page) => page.getByRole("listbox", { name: "Slash commands" });

async function typeDraft(page: Page, text: string) {
	await box(page).click();
	await box(page).fill(text);
	// fill() fires one input event; the menu reacts to it synchronously.
	if (text.startsWith("/") && !text.startsWith("//")) {
		await expect(menu(page)).toBeVisible();
	}
}

test.describe("the / menu", () => {
	test("a leading slash opens the panel commands; arrows move through them", async ({ page }) => {
		await installStubs(page);
		await goto(page);
		await expect(box(page)).toBeVisible();

		await typeDraft(page, "/");
		await expect(menu(page).getByRole("option", { name: "/compact" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/undo" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/redo" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/model" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/mode" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/effort" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/new" })).toBeVisible();

		// Filtering narrows the list; ArrowDown moves the highlight, which the
		// combobox announces via aria-activedescendant.
		await typeDraft(page, "/mo");
		await expect(menu(page).getByRole("option", { name: "/model" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/compact" })).toHaveCount(0);

		await page.keyboard.press("ArrowDown");
		const active = await box(page).getAttribute("aria-activedescendant");
		expect(active).toBeTruthy();
		await page.keyboard.press("ArrowDown");
		const next = await box(page).getAttribute("aria-activedescendant");
		expect(next).toBeTruthy();
		expect(next).not.toBe(active);
	});

	test("Tab accepts the first match into the draft", async ({ page }) => {
		await installStubs(page);
		await goto(page);

		await typeDraft(page, "/com");
		await page.keyboard.press("Tab");
		await expect(box(page)).toHaveValue("/compact ");
		await expect(menu(page)).toHaveCount(0);
	});

	test("Enter on /compact hits the existing compact route", async ({ page }) => {
		const h = await installStubs(page);
		await goto(page);

		await typeDraft(page, "/compact");
		await page.keyboard.press("Enter");

		await expect.poll(() => h.compactBodies, { timeout: 10_000 }).toEqual([{}]);
		// Nothing reached the transcript as a message.
		await expect.poll(() => h.messageBodies).toEqual([]);
		// The draft cleared, so the menu went with it.
		await expect(box(page)).toHaveValue("");
	});

	test("/undo opens the same rollback confirmation the transcript uses", async ({ page }) => {
		const h = await installStubs(page);
		// A transcript with one prompt the machine named: that id is what the
		// revert carries.
		h.frames.push(
			{ type: "messageBoundary", role: "user", messageId: "msg_undo_1" },
			{ type: "user", text: "Clean the build" }
		);
		await goto(page);
		await expect(page.getByText("Clean the build")).toBeVisible();

		await typeDraft(page, "/undo");
		await page.keyboard.press("Enter");

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("Clean the build");
		await expect(dialog).toContainText(/Files the agent changed/);

		await dialog.getByRole("button", { name: "Roll back" }).click();
		await expect
			.poll(() => h.revertBodies, { timeout: 10_000 })
			.toEqual([{ messageId: "msg_undo_1" }]);
		await expect.poll(() => h.messageBodies).toEqual([]);
	});

	test("/model with no argument opens the model/effort picker", async ({ page }) => {
		const h = await installStubs(page);
		await goto(page);

		await typeDraft(page, "/model");
		await page.keyboard.press("Enter");

		// The picker, not the command routes: a bare /model makes no choice.
		await expect(page.getByRole("menu")).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Coder Large" })).toBeVisible();
		expect(h.modelBodies).toEqual([]);
		expect(h.messageBodies).toEqual([]);
	});

	test("/model with a unique match applies it without opening anything", async ({ page }) => {
		const h = await installStubs(page);
		await goto(page);

		await typeDraft(page, "/model flash");
		await page.keyboard.press("Enter");

		await expect
			.poll(() => h.modelBodies, { timeout: 10_000 })
			.toEqual([{ modelId: "pystino/coder-flash" }]);
		await expect(page.getByRole("button", { name: "Model and effort" })).toContainText(
			"Coder Flash"
		);
	});

	test("an unknown /foo goes out as ordinary text, and so does //x", async ({ page }) => {
		const h = await installStubs(page);
		await goto(page);

		await typeDraft(page, "/foo");
		await page.keyboard.press("Enter");
		await expect.poll(() => h.messageBodies, { timeout: 10_000 }).toHaveLength(1);
		expect(h.messageBodies[0]).toMatchObject({ text: "/foo" });

		// The // escape: a draft starting with two slashes never opens the
		// menu, and the text goes out verbatim.
		await box(page).fill("//x");
		await expect(menu(page)).toHaveCount(0);
		await page.keyboard.press("Enter");
		await expect.poll(() => h.messageBodies, { timeout: 10_000 }).toHaveLength(2);
		expect(h.messageBodies[1]).toMatchObject({ text: "//x" });
	});

	test("a command is refused while a turn is running, and the draft survives", async ({ page }) => {
		const h = await installStubs(page);
		h.frames.push(
			{ type: "messageBoundary", role: "user", messageId: "msg_run_1" },
			{ type: "user", text: "Long-running turn" },
			{ type: "turnState", state: "running", serverNow: Date.now() }
		);
		await goto(page);

		// The turn is live: the stop control sits where send would.
		await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

		await typeDraft(page, "/compact");
		await page.keyboard.press("Enter");

		// The compact route was never hit, and the refused command keeps its
		// text in the draft.
		await page.waitForTimeout(500);
		expect(h.compactBodies).toEqual([]);
		await expect(box(page)).toHaveValue("/compact");
	});

	test("the menu yields when the mode pill opens, and Esc reaches the pill", async ({ page }) => {
		await installStubs(page);
		await goto(page);

		await typeDraft(page, "/");
		await expect(menu(page)).toBeVisible();

		await page.getByRole("button", { name: "Plan" }).click();
		const pillMenu = page.getByRole("menu");
		await expect(pillMenu).toBeVisible();
		// The / menu is gone — blur dismissed it — so Esc closes the pill
		// instead of being swallowed by the menu.
		await expect(menu(page)).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(menu(page)).toHaveCount(0);
	});

	test("on a narrow viewport the menu stays above the send/stop overlay", async ({ page }) => {
		await installStubs(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await goto(page);

		// Mobile pins the send control over the composer's bottom-right
		// corner (and swaps in the stop control while running). The menu
		// anchors above the composer instead of over that corner, so the
		// option row is visible AND tappable — Playwright's click refuses to
		// fire when another element covers the target, which is the check.
		await typeDraft(page, "/compact");
		await menu(page).getByRole("option", { name: "/compact" }).click();
		await expect(box(page)).toHaveValue("/compact ");
	});
});

/**
 * The menu's backend half (PROTOCOL.md §6 backend.commands /
 * session.command): the machine's own commands list under their groups, a
 * project command's first run asking once with the shell snippets it would
 * expand, the run carrying the template hash it was confirmed against, the
 * 409 copy when that template changed on the machine, and the panel-only
 * fallback when the machine cannot answer the listing at all.
 */
test.describe("backend commands", () => {
	const BACKEND_COMMANDS = [
		{
			name: "deploy",
			description: "ship it",
			source: "command",
			origin: "project",
			hints: ["$ARGUMENTS"],
			shell: true,
			shellSnippets: ["echo DEPLOY_RAN"],
			templateHash: "c".repeat(64),
		},
		{
			name: "whoami",
			description: "who runs here",
			source: "command",
			origin: "machine",
			hints: [],
			shell: false,
		},
	];

	test("machine commands list under their groups and run without a confirmation", async ({
		page,
	}) => {
		const h = await installStubs(page);
		h.commandList.body = [BACKEND_COMMANDS[1]];
		await goto(page);

		await typeDraft(page, "/who");
		await expect(menu(page).getByRole("option", { name: "/whoami" })).toBeVisible();
		// The group heading the machine origin lands under.
		await expect(menu(page).getByText("Machine", { exact: true })).toBeVisible();

		await page.keyboard.press("Enter");
		await expect.poll(() => h.commandBodies, { timeout: 10_000 }).toHaveLength(1);
		expect(h.commandBodies[0]).toMatchObject({ name: "whoami", arguments: "" });
		await expect.poll(() => h.messageBodies).toEqual([]);
	});

	test("a project command's first run opens the confirmation sheet with its snippets", async ({
		page,
	}) => {
		const h = await installStubs(page);
		h.commandList.body = BACKEND_COMMANDS;
		await goto(page);

		await typeDraft(page, "/deploy prod");
		await page.keyboard.press("Enter");

		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible();
		await expect(sheet).toContainText("This command runs on your machine");
		await expect(sheet).toContainText("echo DEPLOY_RAN");
		// Nothing ran yet: the sheet is the only thing that happened.
		expect(h.commandBodies).toEqual([]);

		await sheet.getByRole("button", { name: "Run /deploy" }).click();
		await expect.poll(() => h.commandBodies, { timeout: 10_000 }).toHaveLength(1);
		expect(h.commandBodies[0]).toMatchObject({
			name: "deploy",
			arguments: "prod",
			templateHash: "c".repeat(64),
		});
	});

	test("a changed template answers 409 and the toast names the review", async ({ page }) => {
		const h = await installStubs(page);
		h.commandList.body = [BACKEND_COMMANDS[1]];
		await page.route(`**/api/v2/code/v1/agents/${AGENT}/command?*`, (route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({
					message: "This command changed on the machine; review it again.",
				}),
			})
		);
		await goto(page);

		await typeDraft(page, "/whoami");
		await page.keyboard.press("Enter");

		await expect(
			page.getByText("This command changed on the machine; review it again.")
		).toBeVisible({
			timeout: 10_000,
		});
	});

	test("a machine that cannot list commands leaves the menu panel-only", async ({ page }) => {
		const h = await installStubs(page);
		h.commandList.status = 404;
		h.commandList.body = "Not available through this endpoint.";
		await goto(page);

		await typeDraft(page, "/");
		await expect(menu(page).getByRole("option", { name: "/compact" })).toBeVisible();
		await expect(menu(page).getByRole("option", { name: "/whoami" })).toHaveCount(0);
		// No error surfaced: the fallback is silent by design.
		await page.keyboard.press("Escape");
		await expect(page.getByText("This command runs on your machine")).toHaveCount(0);
	});
});
