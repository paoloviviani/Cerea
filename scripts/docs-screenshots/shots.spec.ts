/**
 * Screenshots for the user docs (docs/assets), taken from the real app with fake data: the hermetic
 * e2e stack (mock gateway, fake machine), a user called Ada, example.org addresses, nothing real.
 * How to run it: docs/dev/ui-screenshots.md. PNGs land in $SHOTS_OUT; finish.py turns them into
 * the WebP files the docs use.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "../../tests/fixtures.ts";
import { seedUser } from "../../tests/machineHarness.ts";
import { emptyModel } from "../../tests/fake-machine.ts";
import {
	TITLES,
	signInAda,
	seedChats,
	useModel,
	send,
	retitle,
	docChat,
	connectFake,
	confirmPairing,
	shopModel,
	openShop,
	openWaiting,
	phonePage,
} from "./common.ts";

const OUT = process.env.SHOTS_OUT ?? "/var/tmp/shots-tmp/out";
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.SHOTS_ONLY; // a regexp on the test title

const DESKTOP = { width: 1280, height: 800 };
test.use({
	viewport: DESKTOP,
	deviceScaleFactor: 1.25,
	timezoneId: "Europe/Rome",
	locale: "en-GB",
});
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
	if (ONLY && !new RegExp(ONLY).test(info.title)) test.skip();
});

async function shoot(page: Page, name: string, css = false) {
	await page.waitForTimeout(700);
	await page.screenshot({ path: `${OUT}/${name}.png`, ...(css ? { scale: "css" as const } : {}) });
}

for (const scheme of ["light", "dark"] as const) {
	test(`home chat ${scheme}`, async ({ page, db, session, mockOpenAI }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.emulateMedia({ colorScheme: scheme });
		const userId = await signInAda(db, session);
		await docChat(page, db, userId, mockOpenAI);
		await page.mouse.move(700, 600);
		await shoot(page, `cerea-chat-${scheme}`, true);
	});
}

test("chat new chat", async ({ page, db, session }) => {
	await signInAda(db, session, TITLES);
	await page.goto(`${E2E_APP_BASE}/`);
	await expect(page.getByText("What can I help you with today, Ada?")).toBeVisible();
	await shoot(page, "chat-new-chat");
});

test("chat artifact table", async ({ page, db, session, mockOpenAI }) => {
	const userId = await signInAda(db, session, TITLES);
	await useModel(db, userId, "test-org/artifact-tool");
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_table",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "note-apps",
					type: "table",
					title: "Comparison of note-taking apps",
					content:
						"App,Price,Best for\nObsidian,Free,Personal notes\nNotion,Free tier,Team wikis\nLogseq,Free,Research outlines\n",
				}),
			},
		],
		content: [
			"I've created a table artifact named **note-apps** that compares Obsidian, Notion and Logseq on price and best use case. You can view, sort and download it from the artifact panel.",
		],
		chunkDelayMs: 5,
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(
		page,
		"Make a table artifact comparing three note-taking apps (Obsidian, Notion, Logseq) across price, offline support and best use case. Put the table in an artifact."
	);
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByTestId("table-grid")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText("I've created a table artifact")).toBeVisible({ timeout: 30_000 });
	await retitle(db, page, "Compare note-taking apps");
	await page.goto(`${page.url().split("?")[0]}?artifact=note-apps`);
	await expect(page.getByTestId("table-grid")).toBeVisible({ timeout: 30_000 });
	await shoot(page, "chat-artifact-table");
});

test("chat web search", async ({ page, db, session }) => {
	const userId = await signInAda(db, session, TITLES);
	const call = { name: "web_search", parameters: { query: "SvelteKit latest stable release" } };
	const ids = [randomUUID(), randomUUID(), randomUUID()];
	const now = new Date();
	await db.collection("conversations").insertOne({
		userId,
		model: "test-org/test-model",
		title: "SvelteKit latest stable release",
		rootMessageId: ids[0],
		messages: [
			{
				id: ids[0],
				from: "system",
				content: "",
				ancestors: [],
				children: [ids[1]],
				createdAt: now,
				updatedAt: now,
			},
			{
				id: ids[1],
				from: "user",
				content:
					"What is the latest stable release of SvelteKit? Search the web and answer in two sentences with a source.",
				ancestors: [ids[0]],
				children: [ids[2]],
				createdAt: now,
				updatedAt: now,
			},
			{
				id: ids[2],
				from: "assistant",
				content:
					"The current stable release of SvelteKit is **v2.70.3**, which was published on npm just a few days ago. 【https://www.npmjs.com/package/@sveltejs/kit】",
				ancestors: [ids[0], ids[1]],
				children: [],
				createdAt: now,
				updatedAt: now,
				updates: [
					{ type: "tool", subtype: "call", uuid: "t1", call },
					{
						type: "tool",
						subtype: "result",
						uuid: "t1",
						result: {
							status: "success",
							call,
							outputs: [{ text: "@sveltejs/kit 2.70.3 - npmjs.com" }],
						},
					},
					{
						type: "finalAnswer",
						text: "The current stable release of SvelteKit is **v2.70.3**, which was published on npm just a few days ago. 【https://www.npmjs.com/package/@sveltejs/kit】",
						interrupted: false,
					},
				],
			},
		],
		createdAt: now,
		updatedAt: now,
	} as never);
	const conv = await db
		.collection("conversations")
		.findOne({ title: "SvelteKit latest stable release" });
	await page.goto(`${E2E_APP_BASE}/conversation/${conv?._id}`);
	await expect(page.getByText("v2.70.3")).toBeVisible();
	await shoot(page, "chat-web-search");
});

test("schedules", async ({ page, db, session }) => {
	const userId = await signInAda(db, session, TITLES);
	const fake = await connectFake("ada-workstation", "ada-sub", emptyModel());
	try {
		await confirmPairing(page, "ada-workstation");
		const device = await db.collection("codeDevices").findOne({ userId });
		// Tomorrow at h:00 in Rome (UTC+1 in winter).
		const next = (days: number, h: number) => {
			const now = new Date();
			return new Date(
				Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, h - 1)
			);
		};
		const common = {
			userId,
			timezone: "Europe/Rome",
			anchorAt: new Date(),
			enabled: true,
			consecutiveFailures: 0,
			firedCount: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await db.collection("schedules").insertMany([
			{
				...common,
				kind: "agent",
				name: "Nightly test run",
				target: {
					deviceId: String(device?._id),
					workspaceId: "ws-shop",
					sessionMode: "new",
					permissionMode: "ask",
					labels: { machine: "ada-workstation", workspace: "shop-api" },
				},
				prompt: "Run the tests and summarise any failures.",
				recurrence: { type: "daily", at: "09:00" },
				nextRunAt: next(1, 9),
			},
			{
				...common,
				kind: "chat",
				name: "Morning digest",
				target: { mode: "new" },
				prompt: "Summarise yesterday's news about our product.",
				recurrence: { type: "weekdays", at: "08:00" },
				nextRunAt: next(1, 8),
			},
		] as never);
		await page.goto(`${E2E_APP_BASE}/schedules`);
		await expect(page.getByText("Nightly test run")).toBeVisible();
		await expect(page.getByText("Morning digest")).toBeVisible();
		await shoot(page, "schedules");
	} finally {
		fake.close();
	}
});

// ── agents ───────────────────────────────────────────────────────────────────

for (const scheme of ["light", "dark"] as const) {
	test(`agents session waiting ${scheme}`, async ({ page, db, session }) => {
		await page.emulateMedia({ colorScheme: scheme });
		const { fake, deviceId, waiting } = await openShop(page, db, session);
		try {
			await openWaiting(page, `${E2E_APP_BASE}/code?device=${deviceId}&agent=${waiting}`);
			await shoot(page, `agents-session-waiting${scheme === "dark" ? "-dark" : ""}`);
		} finally {
			fake.close();
		}
	});
}

test("agents phone", async ({ browser, db, session, page }) => {
	const { fake, deviceId, waiting } = await openShop(page, db, session);
	try {
		const phone = await phonePage(browser, page);
		await openWaiting(phone, `${E2E_APP_BASE}/code?device=${deviceId}&agent=${waiting}`);
		await shoot(phone, "agents-phone");
		await phone.context().close();
	} finally {
		fake.close();
	}
});

test("agents pair dialog", async ({ page, db, session }) => {
	const userId = await seedUser(db, session.sessionId, "ada-sub");
	await db
		.collection("users")
		.updateOne({ _id: userId }, { $set: { name: "Ada Lovelace", username: "ada.lovelace" } });
	const model = shopModel().model;
	const fake = await connectFake("ada-workstation", "ada-sub", model);
	try {
		await confirmPairing(page, "ada-workstation");
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: /Pair/ }).first().click();
		await expect(page.getByRole("heading", { name: "Pair a computer" })).toBeVisible();
		await page.setViewportSize({ width: 1280, height: 1800 });
		// The stack answers on a loopback address; the docs show an example.org one.
		await page.evaluate(() => {
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if (n.nodeValue?.includes("127.0.0.1"))
					n.nodeValue = n.nodeValue.replace(
						/http:\/\/127\.0\.0\.1:\d+/g,
						"https://cerea.example.org"
					);
			}
		});
		// Just the dialog, with a margin of the dimmed page around it.
		const box = await page.getByRole("dialog").boundingBox();
		if (!box) throw new Error("no dialog");
		await page.waitForTimeout(700);
		await page.screenshot({
			path: `${OUT}/agents-pair-dialog.png`,
			clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
		});
	} finally {
		fake.close();
	}
});

// ── new images ───────────────────────────────────────────────────────────────

test("agents workspace screen", async ({ page, db, session }) => {
	const { fake, deviceId } = await openShop(page, db, session);
	try {
		await page.goto(`${E2E_APP_BASE}/code?device=${deviceId}`);
		await page
			.getByRole("link", { name: /^shop-api/ })
			.first()
			.click();
		await expect(
			page.getByTestId("workspace-screen").getByTestId("workspace-new-session")
		).toBeVisible({ timeout: 30_000 });
		await shoot(page, "agents-workspace-screen");
	} finally {
		fake.close();
	}
});

test("chat share dialog", async ({ page, db, session, mockOpenAI }) => {
	const userId = await signInAda(db, session, TITLES);
	await docChat(page, db, userId, mockOpenAI);
	await page.getByLabel("File panel", { exact: true }).getByTestId("share-link-button").click();
	const dialog = page.getByTestId("share-dialog");
	await expect(dialog.getByTestId("share-preview")).toBeVisible();
	await dialog.getByLabel("Anyone with the link").check();
	await expect(dialog.getByTestId("share-notice")).toBeVisible();
	await shoot(page, "chat-share-dialog");
});

test("workspace agents connectors", async ({ page, db, session }) => {
	const userId = await seedUser(db, session.sessionId, "ada-sub");
	await db
		.collection("users")
		.updateOne({ _id: userId }, { $set: { name: "Ada Lovelace", username: "ada.lovelace" } });
	await seedChats(db, userId, TITLES);
	const notes = (name: string, description: string) => ({
		name,
		description,
		tools: [{ name: "search", description: "Search", handler: () => "ok" }],
	});
	const fake = await connectFake("ada-workstation", "ada-sub", shopModel().model, {
		servers: [
			notes("notes", "Notes kept on this computer"),
			notes("calendar", "Your calendar, read only"),
		],
	});
	try {
		await confirmPairing(page, "ada-workstation");
		await page.setViewportSize({ width: 1280, height: 1000 });
		await page.goto(`${E2E_APP_BASE}/workspace?tab=agents`);
		const heading = page.getByText("Connectors your agents may use", { exact: true });
		await expect(heading).toBeAttached({ timeout: 30_000 });
		await expect(
			page.getByText("Apps on my computers may use these connectors too")
		).toBeAttached();
		// The apps switch at the bottom of the window, so the whole list above it shows.
		await page
			.getByText("Apps on my computers may use these connectors too")
			.evaluate((el) => el.scrollIntoView({ block: "end" }));
		await shoot(page, "workspace-agents-connectors");
	} finally {
		fake.close();
	}
});
