/**
 * Loading placeholders: a region shows its skeleton or its complete content, never half, and a
 * fast load shows no skeleton at all (src/lib/components/skeleton, src/lib/utils/delayedLoading).
 *
 * The slow endpoint is delayed with `page.route`; the app is reached by client navigation from `/`
 * so the sidebar stays on screen while the page under test loads.
 */
import { test, expect, seedConversation, E2E_APP_BASE } from "./fixtures.ts";
import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { Page } from "playwright/test";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";
import { E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures.ts";
import type { Part, Transcript } from "../src/lib/types/machineProtocol";

const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	// A subject of its own per test: the server remembers a subject's user row, and every test
	// wipes and re-creates the rows.
	const sub = `e2e-owner-${randomUUID()}`;
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Owner",
		username: sub,
		hfUserId: sub,
		avatarUrl: undefined,
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("sessions").insertOne({
		sessionId,
		userId: insertedId,
		expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
		createdAt: now,
		updatedAt: now,
		authTime: now,
		oauth: {
			token: { value: "e2e-owner-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

async function seedProjects(db: Db, userId: ObjectId, names: string[]) {
	const now = new Date();
	// `projects` is not wiped between tests: clear this file's leftovers first.
	await db.collection("projects").deleteMany({});
	const ids: ObjectId[] = [];
	for (const name of names) {
		const _id = new ObjectId();
		ids.push(_id);
		await db.collection("projects").insertOne({
			_id,
			userId,
			name,
			description: "",
			instructions: "",
			knowledgeBaseIds: [],
			indexPastChats: false,
			retrievalLimit: 6,
			shares: [],
			createdAt: now,
			updatedAt: now,
		} as never);
	}
	return ids;
}

/** Delays the answer to a URL pattern; the shell and its data (server load) are untouched. */
async function delay(page: Page, pattern: RegExp, ms: number) {
	await page.route(pattern, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		await route.continue();
	});
}

/** Counts every time the named skeleton region is inserted, from the first paint on. */
async function watchSkeletons(page: Page, region: string) {
	await page.addInitScript((region) => {
		const w = window as unknown as { __skeletons: number };
		w.__skeletons = 0;
		new MutationObserver((records) => {
			for (const r of records)
				for (const n of r.addedNodes)
					if (
						n instanceof Element &&
						(n.matches(`[data-region=${region}]`) || n.querySelector(`[data-region=${region}]`))
					)
						w.__skeletons++;
		}).observe(document, { childList: true, subtree: true });
	}, region);
}
const skeletonsSeen = (page: Page) =>
	page.evaluate(() => (window as unknown as { __skeletons: number }).__skeletons);

/** A fake agent computer, paired and with one session, for the /code surfaces. */
async function connectFakeMachine(sub: string, name: string): Promise<FakeMachine> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: token } = (await res.json()) as { access_token: string };
	const fake = new FakeMachine(
		`${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ policy: { workspaceRoots: [], allowFreeModels: false } }
	);
	await fake.hello();
	return fake;
}

async function pairAndStartSession(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this computer" }).click();
	await page.getByRole("button", { name: "Add a workspace to this computer" }).click();
	await page.getByLabel("Directory on the computer").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByRole("link", { name: /^repo/ })).toBeVisible();
	await page.getByRole("button", { name: "Start a session in this workspace" }).click();
	await page.getByRole("button", { name: "Ask", exact: true }).click();
	await page.getByRole("button", { name: "Start session" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

function seededTranscript(turns: number): Transcript {
	const messages: Transcript["messages"] = [];
	for (let i = 1; i <= turns; i += 1) {
		messages.push({
			message: {
				id: `msg_u_${i}`,
				role: "user",
				createdAt: new Date(i * 1000).toISOString(),
				clientMessageId: `c_${i}`,
			},
			parts: [
				{
					id: `part_u_${i}`,
					messageId: `msg_u_${i}`,
					role: "user",
					type: "text",
					text: `prompt ${i}`,
				},
			],
		});
		const parts: Part[] = [
			{
				id: `part_a_${i}`,
				messageId: `msg_a_${i}`,
				role: "assistant",
				type: "text",
				text: `answer ${i}`,
			},
		];
		messages.push({
			message: {
				id: `msg_a_${i}`,
				role: "assistant",
				createdAt: new Date(i * 1000 + 1).toISOString(),
			},
			parts,
		});
	}
	return { messages, permissions: [], status: "idle", usage: null, todos: [] };
}

for (const vp of VIEWPORTS) {
	test.describe(`loading placeholders at ${vp.name}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
		});

		test("the projects list is a busy skeleton, then all its rows in one step", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			await seedProjects(db, userId, ["Alpha", "Bravo", "Charlie", "Delta"]);
			await delay(page, /\/api\/v2\/projects$/, 1500);
			await page.goto(`${E2E_APP_BASE}/projects`, { waitUntil: "domcontentloaded" });

			const region = page.locator("[data-region=projects]");
			await expect(region.first()).toBeVisible();
			await expect(region.first()).toHaveAttribute("aria-busy", "true");
			await expect(region.first()).toContainText("Loading");
			// No row exists while the skeleton shows.
			await expect(page.getByRole("link", { name: /Alpha/ })).toHaveCount(0);

			// First moment any project row exists, all of them do.
			await expect(page.getByRole("link", { name: /Alpha/ }).first()).toBeVisible({
				timeout: 20_000,
			});
			for (const name of ["Bravo", "Charlie", "Delta"]) {
				await expect(page.getByRole("link", { name: new RegExp(name) }).first()).toBeVisible({
					timeout: 1,
				});
			}
			await expect(page.locator("[data-region=projects]")).toHaveCount(0);
		});

		test("a fast response never shows a skeleton", async ({ page, db, session }) => {
			const userId = await installUserSession(db, session.sessionId);
			await seedProjects(db, userId, ["Alpha", "Bravo"]);
			await watchSkeletons(page, "projects");
			await delay(page, /\/api\/v2\/projects$/, 40);
			await page.goto(`${E2E_APP_BASE}/projects`);
			await expect(page.getByRole("link", { name: /Alpha/ }).first()).toBeVisible();
			await page.waitForTimeout(600);
			expect(await skeletonsSeen(page)).toBe(0);
		});

		test("chats list: skeleton, then rows with their project names already in place", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			const [projectId] = await seedProjects(db, userId, ["Mortgage"]);
			for (const title of ["One", "Two", "Three"]) {
				await seedConversation(db, session.sessionId, {
					title,
					raw: { userId, updatedAt: new Date(), projectId },
				});
			}
			await page.goto(`${E2E_APP_BASE}/`);
			// Only the project names arrive late: the rows must wait for them.
			await delay(page, /\/api\/v2\/projects$/, 1500);
			await page.goto(`${E2E_APP_BASE}/chats`, { waitUntil: "domcontentloaded" });

			await expect(page.locator("[data-region=chats]")).toBeVisible();
			await expect(page.getByTestId("chats-row")).toHaveCount(0);
			await expect(page.getByTestId("chats-row")).toHaveCount(3, { timeout: 20_000 });
			// At the first reveal the badge already carries the project's name, never "Project".
			for (const row of await page.getByTestId("chats-row").all()) {
				await expect(row).toContainText("Mortgage", { timeout: 1 });
			}
		});

		for (const mode of ["fails", "hangs", "arrives late"] as const) {
			test(`chats list: a project-names request that ${mode} still shows the chats`, async ({
				page,
				db,
				session,
			}) => {
				const userId = await installUserSession(db, session.sessionId);
				const [projectId] = await seedProjects(db, userId, ["Mortgage"]);
				for (const title of ["One", "Two"]) {
					await seedConversation(db, session.sessionId, {
						title,
						raw: { userId, updatedAt: new Date(), projectId },
					});
				}
				await page.goto(`${E2E_APP_BASE}/`);
				await page.route(/\/api\/v2\/projects$/, async (route) => {
					if (mode === "fails") return route.abort();
					if (mode === "hangs") return new Promise(() => {});
					await new Promise((resolve) => setTimeout(resolve, 3500));
					return route.continue();
				});
				await page.goto(`${E2E_APP_BASE}/chats`, { waitUntil: "domcontentloaded" });
				// Within the wait cap plus slack, never forever; the badge falls back to "Project".
				await expect(page.getByTestId("chats-row")).toHaveCount(2, { timeout: 6000 });
				await expect(page.getByTestId("chats-row").first()).toContainText("Project");
				if (mode === "arrives late") {
					// The names then fill every badge in at once.
					for (const row of await page.getByTestId("chats-row").all()) {
						await expect(row).toContainText("Mortgage", { timeout: 10_000 });
					}
				}
			});
		}

		test("notifications settings: header and tabs do not move when the pane arrives", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await delay(page, /\/api\/v2\/push$/, 1500);
			await page.goto(`${E2E_APP_BASE}/settings/notifications`, { waitUntil: "domcontentloaded" });
			const heading = page.getByRole("heading", { name: "Settings", exact: true });
			await expect(page.locator("[data-region=notifications]")).toBeVisible();
			const before = await heading.boundingBox();
			await expect(page.locator("[data-region=notifications]")).toHaveCount(0, {
				timeout: 20_000,
			});
			const after = await heading.boundingBox();
			expect(after).toEqual(before);
		});

		test("the new-chat page keeps its composer and greeting still while data loads", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await delay(page, /\/api\/v2\/(?!code\/status)/, 1000);
			await page.goto(`${E2E_APP_BASE}/`);
			const composer = page.getByPlaceholder("Ask anything");
			await expect(composer).toBeVisible();
			const first = await composer.boundingBox();
			await page.waitForTimeout(1800);
			expect(await composer.boundingBox()).toEqual(first);
			const title = page.getByTestId("intro-title");
			await expect(title).toHaveCSS("opacity", "1");
		});

		test("the application pane is one skeleton, then every setting at once", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			// The document reader row and the gateway URL come from requests of their own.
			await delay(page, /\/api\/v2\/user\/document-reader$/, 1500);
			await delay(page, /\/api\/v2\/debug\/config$/, 600);
			await page.goto(`${E2E_APP_BASE}/settings/application`, { waitUntil: "domcontentloaded" });

			const region = page.locator("[data-region=application]");
			const heading = page.getByRole("heading", { name: "Settings", exact: true });
			await expect(region).toBeVisible();
			await expect(region).toHaveAttribute("aria-busy", "true");
			const before = await heading.boundingBox();
			// Nothing of the pane shows while its skeleton does, not even the settings that need no request.
			await expect(page.getByTestId("about-server")).toBeHidden();
			await expect(page.getByTestId("document-reader-setting")).toBeHidden();

			// First moment any setting is visible, all of them are, and the skeleton is gone.
			await expect(page.getByTestId("about-server")).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("document-reader-setting")).toBeVisible({ timeout: 1 });
			await expect(page.locator("[data-region=application]")).toHaveCount(0);
			expect(await heading.boundingBox()).toEqual(before);
		});

		test("the application pane shows no skeleton when its requests are fast", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await watchSkeletons(page, "application");
			await delay(page, /\/api\/v2\/user\/document-reader$/, 40);
			await page.goto(`${E2E_APP_BASE}/settings/application`);
			await expect(page.getByTestId("document-reader-setting")).toBeVisible();
			await page.waitForTimeout(600);
			expect(await skeletonsSeen(page)).toBe(0);
		});

		test("usage: the billing group never arrives a beat after the usage rows", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await delay(page, /\/api\/v2\/user\/billing-orgs$/, 1800);
			await page.goto(`${E2E_APP_BASE}/settings/usage`, { waitUntil: "domcontentloaded" });
			const region = page.locator("[data-region=usage]");
			await expect(region).toBeVisible();
			// The usage request itself is fast: the region must outlast it, up to the slow one.
			await page.waitForTimeout(1000);
			await expect(region).toBeVisible();
			await expect(page.locator("[data-region=usage]")).toHaveCount(0, { timeout: 20_000 });
		});

		test("knowledge detail: a skeleton, then the base and its documents in one step", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			const now = new Date();
			const { insertedId: baseId } = await db.collection("vectorStores").insertOne({
				name: "Handbook",
				ownerId: userId,
				embeddingModel: "test-embedding",
				dimensions: null,
				chunkChars: 1200,
				chunkOverlap: 150,
				shares: [],
				createdAt: now,
				updatedAt: now,
			});
			await delay(page, /\/api\/v2\/gateway\/vector_stores\/[0-9a-f]{24}$/, 1500);
			await page.goto(`${E2E_APP_BASE}/knowledge/${baseId}`, { waitUntil: "domcontentloaded" });

			const region = page.locator("[data-region=knowledge-detail]");
			await expect(region).toBeVisible();
			await expect(region).toHaveAttribute("aria-busy", "true");
			await expect(page.getByText("Handbook")).toHaveCount(0);
			// The base and its document list arrive together.
			await expect(page.getByText("Handbook").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("Nothing in it yet")).toBeVisible({ timeout: 1 });
			await expect(page.locator("[data-region=knowledge-detail]")).toHaveCount(0);
		});

		test("knowledge detail: a fast response never shows a skeleton", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			const now = new Date();
			const { insertedId: baseId } = await db.collection("vectorStores").insertOne({
				name: "Handbook",
				ownerId: userId,
				embeddingModel: "test-embedding",
				dimensions: null,
				chunkChars: 1200,
				chunkOverlap: 150,
				shares: [],
				createdAt: now,
				updatedAt: now,
			});
			await watchSkeletons(page, "knowledge-detail");
			await page.goto(`${E2E_APP_BASE}/knowledge/${baseId}`);
			await expect(page.getByText("Handbook").first()).toBeVisible();
			await page.waitForTimeout(600);
			expect(await skeletonsSeen(page)).toBe(0);
		});
	});
}

test.describe("agent session surfaces", () => {
	let fake: FakeMachine | null = null;
	test.afterEach(async ({ page }) => {
		fake?.close();
		fake = null;
		await page.close().catch(() => {});
	});

	async function startSession(page: Page, db: Db, sessionId: string) {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, sessionId, sub);
		const name = `skel-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);
		const machine = fake;
		const created = machine.model.sessions.at(-1);
		if (!created) throw new Error("the pair flow created no session");
		return { machine, sessionId: created.id };
	}

	test("transcript: message skeleton on the first load, then all turns at once", async ({
		page,
		db,
		session,
	}) => {
		const { machine, sessionId } = await startSession(page, db, session.sessionId);
		machine.model.transcripts.set(sessionId, seededTranscript(6));
		const empty: Transcript = {
			messages: [],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const real = seededTranscript(6);
		machine.onOp("session.sync", async (args: { sessionId: string }) => {
			if (args.sessionId !== sessionId) {
				return { epoch: machine.model.epoch, seq: 0, snapshot: empty };
			}
			await new Promise((resolve) => setTimeout(resolve, 1800));
			return {
				epoch: machine.model.epoch,
				seq: machine.model.seq.get(sessionId) ?? 0,
				snapshot: real,
			};
		});
		await page.goto(`${E2E_APP_BASE}/code?device=${machine.deviceId}&agent=${sessionId}`, {
			waitUntil: "domcontentloaded",
		});
		const region = page.locator("[data-region=transcript]");
		const column = page.getByTestId("transcript-loading");
		await expect(region).toBeVisible({ timeout: 20_000 });
		await expect(region).toHaveAttribute("aria-busy", "true");
		const box = await column.boundingBox();
		await expect(page.getByText("prompt 1", { exact: true })).toHaveCount(0);

		// First moment any turn exists, every turn does.
		await expect(page.getByText("prompt 1", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText("answer 6", { exact: true })).toBeVisible({ timeout: 1 });
		await expect(page.locator("[data-region=transcript]")).toHaveCount(0);
		await expect(column).toHaveCount(0);
		// The skeleton filled the same pane the transcript then fills.
		const scroller = await page.getByLabel("Chat messages").boundingBox();
		expect(box && scroller && Math.abs(box.height - scroller.height) < 80).toBe(true);
	});

	test("transcript: a fast session open shows no skeleton", async ({ page, db, session }) => {
		const { machine, sessionId } = await startSession(page, db, session.sessionId);
		machine.model.transcripts.set(sessionId, seededTranscript(3));
		await watchSkeletons(page, "transcript");
		await page.goto(`${E2E_APP_BASE}/code?device=${machine.deviceId}&agent=${sessionId}`);
		await expect(page.getByText("answer 3", { exact: true })).toBeVisible({ timeout: 20_000 });
		await page.waitForTimeout(600);
		expect(await skeletonsSeen(page)).toBe(0);
	});

	test("model picker: placeholder rows while the lists load, then models and efforts together", async ({
		page,
		db,
		session,
	}) => {
		const { machine, sessionId } = await startSession(page, db, session.sessionId);
		machine.onOp("backend.models", async () => {
			await new Promise((resolve) => setTimeout(resolve, 2500));
			return {
				models: [
					{ id: "pystino/coder-large", label: "Coder Large", isDefault: true },
					{ id: "pystino/coder-small", label: "Coder Small", isDefault: false },
				],
			};
		});
		await page.goto(`${E2E_APP_BASE}/code?device=${machine.deviceId}&agent=${sessionId}`);
		const trigger = page.getByRole("button", { name: "Model and effort" });
		await expect(trigger).toBeVisible({ timeout: 20_000 });
		await expect(trigger).toContainText("Loading models");
		await trigger.click();
		const region = page.locator("[data-region=model-picker]");
		await expect(region).toBeVisible();
		await expect(region).toHaveAttribute("aria-busy", "true");
		await expect(page.getByRole("menuitem", { name: /Coder Large/ })).toHaveCount(0);
		// The first model row appears: the menu is complete in that same step.
		await expect(page.getByRole("menuitem", { name: /Coder Large/ })).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.locator("[data-region=model-picker]")).toHaveCount(0);
	});
});
