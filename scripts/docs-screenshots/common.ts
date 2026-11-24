/**
 * Helpers shared by shots.spec.ts (the screenshots) and demo.spec.ts (the README animation): Ada's
 * account and chats, the document chat, the fake machine and its shop-api scenario.
 */
import { randomUUID } from "node:crypto";
import type { Db, ObjectId } from "mongodb";
import type { Browser, Page } from "playwright/test";
import {
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

export const TITLES = [
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

/** Ada, signed in, with a sidebar of older chats (the newest created last, so it sits on top). */
export async function signInAda(
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

export async function seedChats(db: Db, userId: ObjectId, titles: string[]) {
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

export async function useModel(db: Db, userId: ObjectId, model: string) {
	await db.collection("settings").updateOne({ userId }, { $set: { activeModel: model } });
}

export async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

/** Rename the conversation the page is on (the mock's own title is not worth a screenshot). */
export async function retitle(db: Db, page: Page, title: string) {
	const id = page.url().match(/conversation\/([a-f0-9]{24})/)?.[1];
	expect(id).toBeTruthy();
	const { ObjectId } = await import("mongodb");
	await db
		.collection("conversations")
		.updateOne({ _id: new ObjectId(id) }, { $set: { title, updatedAt: new Date() } });
}

export const QUOTA_DOC = `# Recommendation

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

export async function docChat(
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

export async function connectFake(
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
			agentVersion: "0.64.0",
		},
		model
	);
	await fake.hello();
	return fake;
}

export async function confirmPairing(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this computer" }).click();
	await expect(page.getByRole("button", { name: "Confirm this computer" })).toHaveCount(0);
}

export const MIN = 60_000;
export function sessionRow(
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

export function text(id: string, messageId: string, role: string, body: string): Part {
	return { id, messageId, role, type: "text", text: body };
}

/** The shop-api scenario: a waiting edit approval, and other sessions waiting in the sidebar. */
export function shopModel(): {
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

export async function openShop(page: Page, db: Db, session: TestSession) {
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
export async function openWaiting(page: Page, url: string) {
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

/** A phone-sized page in the same session as `page`. */
export async function phonePage(browser: Browser, page: Page): Promise<Page> {
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
