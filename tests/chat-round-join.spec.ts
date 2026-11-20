/**
 * A tool round resumes the turn once, when every call of it is in (C155).
 *
 * The incident (2026-11-19): one round held a slow MCP call and an `execute_code` call; the code
 * result arrived first and resumed the turn while the MCP call was still running. These specs
 * drive the same shapes through the real app: a slow connector call beside a code run, an
 * approval beside a code run, an approval answered with the tab reloaded or closed (the server,
 * not the browser, applies it), Stop mid-round, and a denied or expired approval.
 *
 * The model is the scripted mock: it answers with text as soon as a request carries a tool
 * result, so the number of upstream requests that carry one is the number of times the turn
 * was resumed into the model.
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, MOCK_MCP_URL, waitForHydration } from "./fixtures";
import { seedUser } from "./machineHarness";

const CODE = "print('JOIN' + 'CODE:' + str(6 * 7))";

type Req = { stream: boolean; body: Record<string, unknown> };

/** Streamed upstream requests that already carry a tool result: one per resume into the model. */
function resumes(requests: Req[]): Req[] {
	return requests.filter(
		(r) =>
			r.stream &&
			Array.isArray(r.body.messages) &&
			(r.body.messages as { role?: string }[]).some((m) => m.role === "tool")
	);
}

/** The tool messages of one resumed request, in the order the model sees them. */
function toolMessages(request: Req): { tool_call_id: string; content: string }[] {
	return (request.body.messages as { role?: string; tool_call_id: string; content: string }[])
		.filter((m) => m.role === "tool")
		.map((m) => ({ tool_call_id: m.tool_call_id, content: String(m.content) }));
}

/** A signed-in user with manual approvals and a paired device (what makes `agent_start` offered). */
async function seedApprovalUser(db: Db, sessionId: string) {
	const userId = await seedUser(db, sessionId, `e2e-${randomUUID()}`);
	await db.collection("settings").updateOne({ userId }, { $set: { toolApprovalPolicy: "manual" } });
	await db.collection("codeDevices").insertOne({
		_id: new ObjectId(),
		userId,
		machineId: `m-${randomUUID()}`,
		name: "a-paired-box",
		status: "paired",
		sub: "s",
		iss: "i",
		backends: [],
		policy: {},
		credentialState: "ok",
		createdAt: new Date(),
	});
	return userId;
}

/** The mock MCP server as a connector every chat loads from the start. */
async function seedMockConnector(db: Db) {
	const id = new ObjectId();
	await db.collection("mcpConnectors").insertOne({
		_id: id,
		userId: new ObjectId(),
		scope: "deployment",
		name: "Mock",
		url: MOCK_MCP_URL,
		auth: "none",
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await db.collection("connectorModes").insertOne({
		_id: new ObjectId(),
		key: `connector:${id}`,
		mode: "on",
		alwaysLoaded: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

const AGENT_START = {
	id: "call_agent",
	name: "agent_start",
	arguments: JSON.stringify({
		prompt: "x",
		deviceId: "ffffffffffffffffffffffff",
		workspaceId: "w",
	}),
};
const RUN_CODE = {
	id: "call_code",
	name: "execute_code",
	arguments: JSON.stringify({ code: CODE }),
};

async function send(page: Page, text: string) {
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
}

const lastAssistant = (page: Page) => page.locator('[data-message-role="assistant"]').last();

test.describe("an approval is applied by the server", () => {
	test.beforeEach(async ({ db, session, mockOpenAI }) => {
		await seedApprovalUser(db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [AGENT_START],
			content: ["Approval ", "round ", "done."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
	});

	test("the turn continues in the same open page after Allow once, and the result appears once", async ({
		page,
		mockOpenAI,
	}) => {
		await send(page, "start the agent");
		const last = lastAssistant(page);
		await last.getByRole("button", { name: "Allow once" }).click();
		// No reload: the page picks up the turn the server resumes.
		await expect(lastAssistant(page)).toContainText("Approval round done.", { timeout: 45_000 });
		const after = resumes((await mockOpenAI.requests()) as Req[]);
		expect(after).toHaveLength(1);
		expect(toolMessages(after[0])).toHaveLength(1);
	});

	test("a reload right after the click still ends with the turn finished, once", async ({
		page,
		mockOpenAI,
	}) => {
		await send(page, "start the agent");
		await lastAssistant(page).getByRole("button", { name: "Allow once" }).click();
		await page.reload();
		await waitForHydration(page);
		await expect(lastAssistant(page)).toContainText("Approval round done.", { timeout: 45_000 });
		expect(resumes((await mockOpenAI.requests()) as Req[])).toHaveLength(1);
	});

	test("with the tab closed after the click, the server still applies it and finishes the turn", async ({
		page,
		db,
		mockOpenAI,
	}) => {
		await send(page, "start the agent");
		const url = page.url();
		await lastAssistant(page).getByRole("button", { name: "Allow once" }).click();
		await page.goto("about:blank");
		await expect
			.poll(async () => resumes((await mockOpenAI.requests()) as Req[]).length, {
				timeout: 45_000,
			})
			.toBe(1);
		await page.goto(url);
		await waitForHydration(page);
		await expect(lastAssistant(page)).toContainText("Approval round done.");
		const row = await db.collection("mcpElicitations").findOne({ status: "resolved" });
		expect(row?.consumedAt).toBeTruthy();
	});

	test("Deny shows the denial and the turn continues once", async ({ page, mockOpenAI }) => {
		await send(page, "start the agent");
		await lastAssistant(page).getByRole("button", { name: "Deny" }).click();
		await expect(lastAssistant(page)).toContainText("Approval round done.", { timeout: 45_000 });
		const after = resumes((await mockOpenAI.requests()) as Req[]);
		expect(after).toHaveLength(1);
		expect(toolMessages(after[0])[0].content).toContain("declined");
	});

	test("an approval that expires is denied and the turn continues once", async ({
		page,
		db,
		mockOpenAI,
	}) => {
		await send(page, "start the agent");
		await expect(lastAssistant(page).getByRole("button", { name: "Allow once" })).toBeVisible();
		await db
			.collection("mcpElicitations")
			.updateMany({ status: "pending" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		await expect(lastAssistant(page)).toContainText("Approval round done.", { timeout: 60_000 });
		const after = resumes((await mockOpenAI.requests()) as Req[]);
		expect(after).toHaveLength(1);
		expect(toolMessages(after[0])[0].content).toContain("declined");
	});
});

test("an approval and a code run in one round: answered while the code is pending, the model runs once with both results", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	await seedApprovalUser(db, session.sessionId);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [AGENT_START, RUN_CODE],
		content: ["Both ", "results ", "in."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});
	// Hold the Python runtime so the code is still pending when the approval is answered.
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.context().route("**/pyodide/pyodide.mjs", async (route) => {
		await gate;
		await route.continue();
	});

	await send(page, "agent and code");
	await lastAssistant(page).getByRole("button", { name: "Allow once" }).click();
	// The approval is applied; the code is still pending: the model has not run.
	await expect
		.poll(
			async () =>
				db.collection("mcpElicitations").countDocuments({ consumedAt: { $exists: true } }),
			{
				timeout: 30_000,
			}
		)
		.toBe(1);
	expect(resumes((await mockOpenAI.requests()) as Req[])).toHaveLength(0);

	release();
	await expect(lastAssistant(page)).toContainText("Both results in.", { timeout: 120_000 });
	const after = resumes((await mockOpenAI.requests()) as Req[]);
	expect(after).toHaveLength(1);
	const messages = toolMessages(after[0]);
	expect(messages).toHaveLength(2);
	expect(messages[1].content).toContain("JOINCODE:42");
});

test("a slow connector call and a code run in one round: one resume, both results, in call order", async ({
	page,
	db,
	mockOpenAI,
	mockMcp,
}) => {
	test.setTimeout(180_000);
	await seedMockConnector(db);
	await mockMcp.reset();
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_slow",
				name: "slow",
				arguments: JSON.stringify({ ms: 12_000, text: "SLOWDONE" }),
			},
			RUN_CODE,
		],
		content: ["Joined."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await send(page, "slow and code");
	await expect(lastAssistant(page)).toContainText("Joined.", { timeout: 120_000 });
	const after = resumes((await mockOpenAI.requests()) as Req[]);
	expect(after).toHaveLength(1);
	const messages = toolMessages(after[0]);
	expect(messages).toHaveLength(2);
	expect(messages[0].content).toContain("SLOWDONE");
	expect(messages[1].content).toContain("JOINCODE:42");
	expect((await mockMcp.calls()).filter((c) => c.name === "slow")).toHaveLength(1);
});

test("Stop mid-round ends the turn and nothing resumes it afterwards", async ({
	page,
	db,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	await seedMockConnector(db);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_slow",
				name: "slow",
				arguments: JSON.stringify({ ms: 40_000, text: "SLOWDONE" }),
			},
			RUN_CODE,
		],
		content: ["Should not appear."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await send(page, "slow and code, then stop");
	// The code has run and the connector call is still going.
	await expect(page.getByTestId("code-execution-card")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: "Stop generating" }).click();
	await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
		timeout: 30_000,
	});
	// Past more than one parked sweep (10 s) and the reaper: nothing resumes the stopped turn.
	await page.waitForTimeout(16_000);
	expect(resumes((await mockOpenAI.requests()) as Req[])).toHaveLength(0);
	await expect(lastAssistant(page)).not.toContainText("Should not appear.");
	const rows = await db.collection("parkedCalls").find({}).toArray();
	expect(rows.every((r) => r.status !== "resumed" && r.status !== "resuming")).toBe(true);
});
