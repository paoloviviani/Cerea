/**
 * Relayed coordination against real machines (ADR 0121): two computers of one user, and one of
 * another user, each the real `galopin` supervising a real `opencode serve` (only the LLM and the
 * IdP are mocked). An agent on one computer sends to, reads and starts sessions on the other,
 * every use behind a card the user answers in Cerea; Cerea's own audit and the target's own log
 * carry the same relay id; the other user's computer is not addressable.
 *
 * The cases the real binary cannot produce are in the vitest specs beside `machineCoord.ts`: a
 * galopin that skips the card (a call with no ticket is refused), an older galopin (capability
 * off), and a chain of four hops (Cerea's ledger refuses the fourth).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import type { APIRequestContext, Page } from "playwright/test";
import type { Db } from "mongodb";
import {
	E2E_APP_BASE,
	E2E_APP_URL,
	installSession,
	seedSettings,
	test,
	expect,
	type MockOpenAIControl,
} from "./fixtures";
import {
	opencodeAvailable,
	seedUser,
	startMachine,
	type Machine,
	type MachinePolicy,
} from "./machineHarness";

interface Computer {
	machine: Machine;
	name: string;
	deviceId: string;
	workspaceId: string;
	sessionId: string;
}

const MESSAGE = "please review the migration";

test.describe("relayed coordination across computers", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 240_000 });

	let machines: Machine[] = [];

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		for (const m of machines) {
			if (testInfo.status !== testInfo.expectedStatus) {
				await testInfo.attach(`galopin-${m.name}.log`, {
					body: m.logs(),
					contentType: "text/plain",
				});
			}
			await m.stop();
		}
		machines = [];
	});

	const api = async (
		request: APIRequestContext,
		method: "GET" | "POST" | "PATCH",
		path: string,
		data?: unknown
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const res = await request.fetch(`${E2E_APP_URL}/api/v2/${path}`, {
			method,
			headers: { origin: new URL(E2E_APP_URL).origin, "content-type": "application/json" },
			...(data !== undefined ? { data: JSON.stringify(data) } : {}),
		});
		const text = await res.text();
		let body: Record<string, unknown> = {};
		try {
			body = (superjson.parse(text) ?? {}) as Record<string, unknown>;
		} catch {
			// not superjson: an error page; the status says what happened
		}
		return { status: res.status(), body };
	};

	/** Start a machine for `sub`, confirm it as the signed-in owner, add its workspace and a session. */
	async function computer(
		request: APIRequestContext,
		db: Db,
		sub: string,
		name: string,
		policy?: MachinePolicy
	): Promise<Computer> {
		const machine = await startMachine({ sub, name, policy });
		machines.push(machine);
		await expect
			.poll(async () => await db.collection("codeDevices").findOne({ name }), {
				timeout: 60_000,
			})
			.not.toBeNull();
		const device = await db.collection("codeDevices").findOne({ name });
		const deviceId = String(device?._id);
		expect(
			(await api(request, "PATCH", `code/devices?id=${deviceId}`, { action: "confirm" })).status
		).toBe(200);
		const ws = await api(request, "POST", `code/v1/workspaces?device=${deviceId}`, {
			path: machine.workspace,
			title: `${name}-repo`,
		});
		const workspaceId = (ws.body.workspace as { id: string }).id;
		const agent = await api(request, "POST", `code/v1/agents?device=${deviceId}`, {
			workspaceId,
			provider: "opencode",
			posture: "build",
			title: `${name} session`,
		});
		const sessionId = (agent.body.agent as { id: string }).id;
		return { machine, name, deviceId, workspaceId, sessionId };
	}

	async function twoComputers(page: Page, db: Db, sessionId: string, policyB?: MachinePolicy) {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, sessionId, sub);
		await page.goto(`${E2E_APP_BASE}/code`);
		const a = await computer(page.request, db, sub, "desk", {});
		const b = await computer(page.request, db, sub, "laptop", policyB);
		return { a, b, sub };
	}

	const sendScenario = (b: Computer, text = MESSAGE) => ({
		toolCalls: [
			{
				id: "call_relay_send",
				name: "session_send",
				arguments: JSON.stringify({ target: `${b.deviceId}:${b.sessionId}`, text }),
			},
		],
		toolCallsOnce: true,
		content: ["Sent", " it", "."],
		chunkDelayMs: 10,
		finishReason: "stop" as const,
	});

	const say = (page: Page, device: string, session: string, text: string) =>
		api(page.request, "POST", `code/v1/agents/${session}/messages?device=${device}`, { text });

	/** The cards waiting on a computer, as the Needs-you inbox reads them. */
	const pending = async (page: Page, device: string) =>
		((await api(page.request, "GET", `code/v1/permissions/pending?device=${device}`)).body
			.permissions as Array<{
			sessionId: string;
			request: { id: string; tool: string; metadata: { relay?: Record<string, unknown> } };
		}>) ?? [];

	const waitForCard = async (page: Page, device: string) => {
		let cards: Awaited<ReturnType<typeof pending>> = [];
		await expect
			.poll(
				async () => (cards = (await pending(page, device)).filter((c) => c.request.metadata.relay)),
				{
					timeout: 90_000,
				}
			)
			.toHaveLength(1);
		return cards[0];
	};

	const answerCard = (
		page: Page,
		device: string,
		card: { sessionId: string; request: { id: string } },
		decision: "once" | "reject"
	) =>
		api(
			page.request,
			"POST",
			`code/v1/agents/${card.sessionId}/permissions/${card.request.id}?device=${device}`,
			{ decision }
		);

	/** What the model was told a tool answered, from the requests the mock saw. */
	const toolResults = async (mockOpenAI: MockOpenAIControl) =>
		JSON.stringify((await mockOpenAI.requests()).map((r) => r.body)).replace(/\\"/g, '"');

	const auditRows = (db: Db, action: RegExp) =>
		db
			.collection("codeAudit")
			.find({ action: { $regex: action } })
			.sort({ at: 1 })
			.toArray();

	const targetLog = (b: Computer) =>
		readFileSync(join(b.machine.root, "state", "audit.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);

	test("A on Allow sends to B: a card on A's session, delivered labelled, audited on both machines", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		expect(
			(
				await api(
					page.request,
					"POST",
					`code/v1/agents/${a.sessionId}/permission-mode?device=${a.deviceId}`,
					{ mode: "allow" }
				)
			).status
		).toBe(200);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await page.goto(`${E2E_APP_BASE}/code?device=${a.deviceId}&agent=${a.sessionId}`);
		await say(page, a.deviceId, a.sessionId, "tell the other computer");

		// A card, although the session is on Allow: the words of the other computer are Cerea's record.
		const transcript = page.getByLabel("Chat messages");
		await expect(transcript.getByTestId("relay-badge")).toBeVisible({ timeout: 90_000 });
		await expect(transcript.getByTestId("relay-from")).toContainText("desk-repo on desk");
		await expect(transcript.getByTestId("relay-to")).toContainText(
			"laptop session, in laptop-repo on laptop"
		);
		await expect(transcript.getByTestId("relay-body")).toContainText(MESSAGE);
		await expect(
			transcript.getByRole("button", { name: "Always allow (this session)" })
		).toHaveCount(0);
		await transcript.getByRole("button", { name: "Allow once" }).click();
		await expect(transcript.getByText("Sent it.")).toBeVisible({ timeout: 90_000 });

		// B's session shows who sent it, and the envelope names the approval.
		await page.goto(`${E2E_APP_BASE}/code?device=${b.deviceId}&agent=${b.sessionId}`);
		const sent = page.getByTestId("sent-by-agent").first();
		await expect(sent).toBeVisible({ timeout: 90_000 });
		await expect(sent).toContainText("From agent");
		await expect(sent).toContainText("desk session");
		await expect(page.getByTestId("sent-by-computer").first()).toContainText("on desk");
		await expect(sent).toContainText(MESSAGE);
		await expect(sent).toContainText("Your person approved sending it.");

		// Two records with one relay id: Cerea's row and the target's own line, and none holds the text.
		const [row] = await auditRows(db, /^coord\.send$/);
		expect(row).toMatchObject({
			outcome: "ok",
			origin: "agent",
			sessionId: a.sessionId,
			targetDeviceId: b.deviceId,
			targetSessionId: b.sessionId,
		});
		const recv = targetLog(b).find((l) => l.action === "coord.recv" && l.op === "coord.send");
		expect(recv).toMatchObject({ outcome: "ok", relayId: row.relayId, fromComputer: a.deviceId });
		expect(JSON.stringify([row, recv])).not.toContain("migration");
		expect((await auditRows(db, /^coord\.approval$/)).map((r) => r.outcome)).toEqual(["approved"]);
	});

	test("Ask and Auto (Agents runs) are a card each too, and the reviewer answers none", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await say(page, a.deviceId, a.sessionId, "tell the other computer");
		const first = await waitForCard(page, a.deviceId);
		expect(first.request.metadata.relay).toMatchObject({ approvable: true, op: "send" });
		expect((await answerCard(page, a.deviceId, first, "reject")).status).toBe(200);
		await expect.poll(async () => (await pending(page, a.deviceId)).length).toBe(0);

		// Auto: the user's rows let agents run, and a relayed call still asks.
		expect(
			(
				await api(
					page.request,
					"POST",
					`code/v1/agents/${a.sessionId}/permission-mode?device=${a.deviceId}`,
					{ mode: "ask", auto: true }
				)
			).status
		).toBe(200);
		await mockOpenAI.setDefaultScenario(sendScenario(b, "second message"));
		await say(page, a.deviceId, a.sessionId, "again");
		const second = await waitForCard(page, a.deviceId);
		expect(second.request.id).not.toBe(first.request.id);
		expect(await db.collection("agentReviewLog").countDocuments({})).toBe(0);
		expect((await answerCard(page, a.deviceId, second, "once")).status).toBe(200);
		await expect
			.poll(async () => (await auditRows(db, /^coord\.send$/)).length, { timeout: 90_000 })
			.toBe(1);
		expect((await auditRows(db, /^coord\.approval$/)).map((r) => r.outcome)).toEqual([
			"rejected",
			"approved",
		]);
	});

	test("Plan refuses, with no card", async ({ page, db, session, mockOpenAI }) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		expect(
			(
				await api(
					page.request,
					"POST",
					`code/v1/agents/${a.sessionId}/permission-mode?device=${a.deviceId}`,
					{ mode: "deny" }
				)
			).status
		).toBe(200);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await say(page, a.deviceId, a.sessionId, "tell the other computer");
		await expect
			.poll(async () => (await toolResults(mockOpenAI)).includes("Plan"), { timeout: 90_000 })
			.toBe(true);
		expect(await pending(page, a.deviceId)).toEqual([]);
		expect(await auditRows(db, /^coord\./)).toEqual([]);
	});

	test("read, then start a session on B in a chosen workspace: each a card, the new session on Ask", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_relay_read",
					name: "session_read",
					arguments: JSON.stringify({ target: `${b.deviceId}:${b.sessionId}`, last: 5 }),
				},
			],
			toolCallsOnce: true,
			content: ["Read", " it", "."],
			chunkDelayMs: 10,
			finishReason: "stop" as const,
		});
		await say(page, a.deviceId, a.sessionId, "read the other session");
		const read = await waitForCard(page, a.deviceId);
		expect(read.request.metadata.relay).toMatchObject({ approvable: true, op: "read", last: 5 });
		await answerCard(page, a.deviceId, read, "once");
		await expect
			.poll(async () => (await auditRows(db, /^coord\.read$/)).length, { timeout: 90_000 })
			.toBe(1);

		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_relay_spawn",
					name: "session_spawn",
					arguments: JSON.stringify({
						title: "Changelog helper",
						prompt: "write the changelog for the migration",
						mode: "build",
						computer: b.deviceId,
						workspaceId: b.workspaceId,
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Started", " it", "."],
			chunkDelayMs: 10,
			finishReason: "stop" as const,
		});
		await say(page, a.deviceId, a.sessionId, "start a helper over there");
		await page.goto(`${E2E_APP_BASE}/code?device=${a.deviceId}&agent=${a.sessionId}`);
		const transcript = page.getByLabel("Chat messages");
		await expect(transcript.getByTestId("relay-starts-on-ask")).toBeVisible({ timeout: 90_000 });
		await expect(transcript.getByTestId("relay-body")).toContainText(
			"write the changelog for the migration"
		);
		await expect(transcript.getByTestId("relay-to")).toContainText(
			"workspace laptop-repo on laptop"
		);
		await transcript.getByRole("button", { name: "Allow once" }).click();
		await expect
			.poll(async () => (await auditRows(db, /^coord\.spawn$/)).length, { timeout: 90_000 })
			.toBe(1);

		const list = (await api(page.request, "GET", `code/v1/agents?device=${b.deviceId}`)).body
			.agents as Array<{ id: string; title: string; permissionMode?: string }>;
		const spawned = list.find((s) => s.title.startsWith("[from desk]"));
		expect(spawned?.title).toContain("Changelog helper");
		expect(spawned?.permissionMode).toBe("ask");
	});

	test("an offline B: a clear error, nothing queued, nothing delivered", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		await b.machine.stop();
		await expect
			.poll(
				async () => (await api(page.request, "GET", `code/v1/agents?device=${b.deviceId}`)).status,
				{ timeout: 60_000 }
			)
			.toBeGreaterThanOrEqual(500);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await say(page, a.deviceId, a.sessionId, "tell the other computer");
		await expect
			.poll(
				async () =>
					(await toolResults(mockOpenAI)).includes("laptop is offline; nothing was sent."),
				{ timeout: 90_000 }
			)
			.toBe(true);
		expect(await pending(page, a.deviceId)).toEqual([]);
		expect(await auditRows(db, /^coord\.send/)).toEqual([]);
	});

	test("the user's switch: off refuses with the reason, on works again", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { a, b } = await twoComputers(page, db, session.sessionId);
		const set = (on: boolean) =>
			api(page.request, "POST", "user/settings", {
				relayedCoordinationEnabled: on,
				activeModel: "test-org/test-model",
			});
		expect((await set(false)).status).toBeLessThan(300);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await say(page, a.deviceId, a.sessionId, "tell the other computer");
		await expect
			.poll(
				async () =>
					(await toolResults(mockOpenAI)).includes("Relayed coordination is switched off"),
				{ timeout: 90_000 }
			)
			.toBe(true);
		expect(await pending(page, a.deviceId)).toEqual([]);
		expect((await auditRows(db, /^coord\.switch$/)).map((r) => r.outcome)).toEqual(["off"]);

		expect((await set(true)).status).toBeLessThan(300);
		await mockOpenAI.setDefaultScenario(sendScenario(b));
		await say(page, a.deviceId, a.sessionId, "now again");
		const card = await waitForCard(page, a.deviceId);
		expect(card.request.metadata.relay).toMatchObject({ approvable: true });
	});

	test("another user's computer is not addressable", async ({
		page,
		db,
		session,
		mockOpenAI,
		browser,
	}) => {
		const { a } = await twoComputers(page, db, session.sessionId);
		// A second user with a computer of their own.
		const otherContext = await browser.newContext();
		const other = await installSession(otherContext);
		const otherSub = `e2e-${randomUUID()}`;
		await db.collection("users").insertOne({
			name: "Other",
			username: "e2e-other",
			hfUserId: otherSub,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const otherUser = await db.collection("users").findOne({ hfUserId: otherSub });
		if (!otherUser) throw new Error("the second user was not created");
		await db.collection("sessions").insertOne({
			sessionId: other.sessionId,
			userId: otherUser._id,
			expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
			createdAt: new Date(),
			updatedAt: new Date(),
			authTime: new Date(),
		} as never);
		await seedSettings(db, other.sessionId, { userId: otherUser._id });
		const stranger = await computer(otherContext.request, db, otherSub, "strangerbox");

		await mockOpenAI.setDefaultScenario(sendScenario(stranger));
		await say(page, a.deviceId, a.sessionId, "tell the other user's computer");
		await expect
			.poll(async () => (await toolResults(mockOpenAI)).includes("No such computer."), {
				timeout: 90_000,
			})
			.toBe(true);
		expect(await pending(page, a.deviceId)).toEqual([]);
		expect(targetLog(stranger).filter((l) => String(l.action).startsWith("coord."))).toEqual([]);
		await otherContext.close();
	});
});
