/**
 * Screenshots for the user docs (docs/assets), taken from the real app with fake data: the hermetic
 * e2e stack (mock gateway, fake machine), a user called Ada, example.org addresses, nothing real.
 * How to run it: docs/dev/ui-screenshots.md. PNGs land in $SHOTS_OUT; finish.py turns them into
 * the WebP files the docs use.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Db, ObjectId } from "mongodb";
import type { Browser, Page } from "playwright/test";
import {
	test,
	expect,
	E2E_APP_BASE,
	E2E_APP_URL,
	MOCK_OIDC_ISSUER,
	type TestSession,
} from "../../tests/fixtures.ts";
import { seedUser } from "../../tests/machineHarness.ts";
import { FakeMachine, emptyModel, type FakeMcpOptions } from "../../tests/fake-machine.ts";
import type {
	PendingPermission,
	Part,
	Session,
	Transcript,
} from "../../src/lib/types/machineProtocol.ts";

const OUT = process.env.SHOTS_OUT ?? "/var/tmp/shots-tmp/out";
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.SHOTS_ONLY; // a regexp on the test title

const TITLES = [
	"Quota policy recommendation",
	"Draft the Q4 launch announcement",
	"Release notes outline",
	"Infra sync: meeting summary",
	"SQLite vs Postgres for small teams",
	"Explain our retry policy",
	"Onboarding checklist for new hires",
	"Rename photos with a Python script",
	"Summarise the vendor contract",
	"Names for the usage dashboard",
	"Weekly status email",
	"SvelteKit upgrade notes",
	"Trip itinerary for Turin",
	"Regex to validate invoice numbers",
	"Meeting agenda for Monday",
	"Compare two pricing tiers",
];

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

/** Ada, signed in, with a sidebar of older chats (the newest created last, so it sits on top). */
async function signInAda(
	db: Db,
	session: TestSession,
	titles = TITLES.slice(1)
): Promise<ObjectId> {
	const userId = await seedUser(db, session.sessionId, "ada-sub");
	await db
		.collection("users")
		.updateOne({ _id: userId }, { $set: { name: "Ada Lovelace", username: "ada.lovelace" } });
	await seedChats(db, userId, titles);
	return userId;
}

async function seedChats(db: Db, userId: ObjectId, titles: string[]) {
	const base = Date.now() - 3600e3;
	let i = 0;
	for (const title of titles.slice().reverse()) {
		const at = new Date(base + i++ * 1000);
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		await db.collection("conversations").insertOne({
			userId,
			model: "test-org/test-model",
			title,
			rootMessageId: ids[0],
			messages: [
				{
					id: ids[0],
					from: "system",
					content: "",
					ancestors: [],
					children: [ids[1]],
					createdAt: at,
					updatedAt: at,
				},
				{
					id: ids[1],
					from: "user",
					content: title,
					ancestors: [ids[0]],
					children: [ids[2]],
					createdAt: at,
					updatedAt: at,
				},
				{
					id: ids[2],
					from: "assistant",
					content: "Sure.",
					ancestors: [ids[0], ids[1]],
					children: [],
					createdAt: at,
					updatedAt: at,
				},
			],
			createdAt: at,
			updatedAt: at,
		} as never);
	}
}

async function useModel(db: Db, userId: ObjectId, model: string) {
	await db.collection("settings").updateOne({ userId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

/** Rename the conversation the page is on (the mock's own title is not worth a screenshot). */
async function retitle(db: Db, page: Page, title: string) {
	const id = page.url().match(/conversation\/([a-f0-9]{24})/)?.[1];
	expect(id).toBeTruthy();
	const { ObjectId } = await import("mongodb");
	await db
		.collection("conversations")
		.updateOne({ _id: new ObjectId(id) }, { $set: { title, updatedAt: new Date() } });
}

const QUOTA_DOC = `# Recommendation

- Set a per-person daily limit of 5 units.
- Allocate a per-group monthly cap of 200 units.
- Apply an organisation-wide monthly ceiling of 800 units.

# Why

- Balances individual productivity with team resource fairness.
- Prevents any single group from consuming a disproportionate share.
- Keeps overall usage within a sustainable budget.

# Rollout

- Communicate limits via internal channels.
- Monitor usage for the first month and adjust thresholds if needed.
- Enforce limits through automated quota enforcement tools.
`;

async function docChat(
	page: Page,
	db: Db,
	userId: ObjectId,
	mockOpenAI: { setDefaultScenario(s: unknown): Promise<void> }
) {
	await useModel(db, userId, "test-org/artifact-tool");
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_doc",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "quota-policy",
					type: "markdown",
					title: "Quota policy recommendation",
					content: QUOTA_DOC,
				}),
			},
		],
		content: [
			"One sentence: I've created a markdown document titled **Quota policy recommendation** with the requested headings and bullet points.",
		],
		chunkDelayMs: 5,
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(
		page,
		"Look at our quota options (per-person daily, per-group monthly, organisation-wide monthly cap) and recommend a policy for a 40-person team. Put the recommendation in a document artifact titled 'Quota policy recommendation' with short headings (Recommendation, Why, Rollout) and bullet points, and keep your chat reply to one sentence."
	);
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(
		page
			.getByLabel("File panel", { exact: true })
			.getByRole("heading", { name: "Recommendation", exact: true })
	).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText("One sentence: I've created")).toBeVisible({ timeout: 30_000 });
	await retitle(db, page, "Quota policy recommendation");
	await page.goto(`${page.url().split("?")[0]}?artifact=quota-policy`);
	await expect(
		page
			.getByLabel("File panel", { exact: true })
			.getByRole("heading", { name: "Recommendation", exact: true })
	).toBeVisible({ timeout: 30_000 });
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

async function connectFake(
	name: string,
	sub: string,
	model = emptyModel(),
	mcp?: FakeMcpOptions
): Promise<FakeMachine> {
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
		{
			machine: { capabilities: { terminal: true, files: true, ...(mcp ? { mcp: true } : {}) } },
			...(mcp ? { mcp } : {}),
			policy: { workspaceRoots: [], allowFreeModels: false, terminal: "allowed" },
			hostname: name,
			agentVersion: "0.55.1",
		},
		model
	);
	await fake.hello();
	return fake;
}

async function confirmPairing(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this computer" }).click();
	await expect(page.getByRole("button", { name: "Confirm this computer" })).toHaveCount(0);
}

const MIN = 60_000;
function sessionRow(
	id: string,
	workspaceId: string,
	title: string,
	minutesAgo: number,
	pending: number,
	mode: "ask" | "allow" = "ask"
): Session {
	const at = new Date(Date.now() - minutesAgo * MIN).toISOString();
	return {
		id,
		workspaceId,
		backend: "opencode",
		title,
		status: pending ? "busy" : "idle",
		pendingPermissions: pending,
		modeId: "build",
		modelId: "pystino/qwen3-30b",
		permissionMode: mode,
		parentId: null,
		createdAt: at,
		updatedAt: at,
		usage: null,
	};
}

function text(id: string, messageId: string, role: string, body: string): Part {
	return { id, messageId, role, type: "text", text: body };
}

/** The shop-api scenario: a waiting edit approval, and other sessions waiting in the sidebar. */
function shopModel(): {
	model: ReturnType<typeof emptyModel>;
	waiting: string;
	pending: PendingPermission[];
} {
	const model = emptyModel();
	model.models = [
		{
			id: "pystino/qwen3-30b",
			label: "Qwen3 30B Instruct",
			providerId: "pystino",
			isDefault: true,
		},
	];
	model.modes = [
		{ id: "plan", label: "Plan" },
		{ id: "build", label: "Build" },
	];
	const ws = {
		id: "ws-shop",
		name: "shop-api",
		path: "/home/ada/work/shop-api",
		createdAt: new Date(Date.now() - 30 * 24 * 3600e3).toISOString(),
		isGitRepo: true,
		branch: "main",
	};
	model.workspaces = [ws];
	const waiting = "ses-coupon";
	const rows: Array<[string, string, number, number]> = [
		["ses-house", "Auto housekeeping", 1, 1],
		["ses-cache", "Tidy test caches", 120, 1],
		["ses-build", "Clean build folders", 125, 1],
		[waiting, "Fix coupon rounding", 130, 1],
		["ses-art", "Cleanup build artifacts", 420, 0],
		["ses-cart", "Check cart totals", 430, 0],
		["ses-valid", "Validate input", 440, 0],
		["ses-save", "Fix SAVE10 coupon bug", 450, 0],
	];
	model.sessions = rows.map(([id, title, ago, pending]) =>
		sessionRow(id, ws.id, title, ago, pending)
	);
	const prompt =
		"In cart.py the SAVE10 coupon takes 10 euro instead of 10 percent. Fix it with an edit to cart.py, then run python3 -m pytest.";
	const tool = (
		id: string,
		name: string,
		input: Record<string, unknown>,
		status: "completed" | "running",
		output?: string
	): Part => ({
		id: `p_${id}`,
		messageId: "m_a",
		role: "assistant",
		type: "tool",
		callId: id,
		tool: name,
		status,
		input,
		...(output ? { output } : {}),
	});
	const request = {
		id: "perm-edit",
		sessionId: waiting,
		tool: "edit",
		title: "Change cart.py",
		patterns: ["cart.py"],
		metadata: { filepath: "cart.py" },
		callId: "c3",
		always: ["cart.py"],
		class: "edit" as const,
	};
	const transcript: Transcript = {
		messages: [
			{
				message: {
					id: "m_u",
					role: "user",
					createdAt: new Date(Date.now() - 130 * MIN).toISOString(),
				},
				parts: [text("p_u", "m_u", "user", prompt)],
			},
			{
				message: {
					id: "m_a",
					role: "assistant",
					createdAt: new Date(Date.now() - 129 * MIN).toISOString(),
				},
				parts: [
					tool("c1", "glob", { pattern: "**/cart.py" }, "completed", "cart.py"),
					tool(
						"c2",
						"read",
						{ filePath: "/home/ada/work/shop-api/cart.py" },
						"completed",
						"def apply_coupon(total, code): ..."
					),
					tool("c3", "edit", { filePath: "/home/ada/work/shop-api/cart.py" }, "running"),
				],
			},
		],
		permissions: [request],
		status: "busy",
		usage: null,
		todos: [],
	};
	model.transcripts.set(waiting, transcript);
	const pending: PendingPermission[] = rows
		.filter(([id, , , p]) => p && id !== waiting)
		.map(([id, title]) => ({
			sessionId: id,
			workspaceId: ws.id,
			sessionTitle: title,
			request: { ...request, id: `perm-${id}`, sessionId: id, title: `Change ${title}` },
		}));
	pending.push({
		sessionId: waiting,
		workspaceId: ws.id,
		sessionTitle: "Fix coupon rounding",
		request,
	});
	return { model, waiting, pending };
}

async function openShop(page: Page, db: Db, session: TestSession) {
	const userId = await seedUser(db, session.sessionId, "ada-sub");
	await db
		.collection("users")
		.updateOne({ _id: userId }, { $set: { name: "Ada Lovelace", username: "ada.lovelace" } });
	const scenario = shopModel();
	const fake = await connectFake("ada-workstation", "ada-sub", scenario.model);
	fake.onOp("permissions.pending", () => ({ permissions: scenario.pending, questions: [] }));
	await confirmPairing(page, "ada-workstation");
	const device = await db.collection("codeDevices").findOne({ userId });
	return { fake, deviceId: String(device?._id), ...scenario };
}

/** Open a waiting session and wait until its model list has loaded (reload if the first try could not). */
async function openWaiting(page: Page, url: string) {
	// The model list is the one call that sometimes finds the fake machine gone while the rest of
	// the page loads (the shared box's network flaps), so its answer is fixed here.
	await page.route("**/api/v2/code/v1/providers/*/models*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					models: [{ id: "pystino/qwen3-30b", label: "Qwen3 30B Instruct", isDefault: true }],
					hidden: 0,
				},
			}),
		})
	);
	await page.goto(url);
	await expect(page.getByRole("button", { name: "Allow once" }).first()).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText(/^Model:/)).toBeVisible({ timeout: 30_000 });
}

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

/** A phone-sized page in the same session as `page`. */
async function phonePage(browser: Browser, page: Page): Promise<Page> {
	const state = await page.context().storageState();
	const context = await browser.newContext({
		storageState: state,
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
	});
	const phone = await context.newPage();
	const { stubCodeStatus } = await import("../../tests/fixtures.ts");
	await stubCodeStatus(phone);
	return phone;
}

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
