/**
 * An approval answered on the FIRST turn of a conversation resumes it. The turn that parks on
 * the card is still held under the id the tab made up for it until the post-stream refresh
 * brings the server's id; an "Allow once" clicked before that refresh used to resume against
 * an id the thread did not hold yet ("Message to write to not found") and the turn stayed
 * parked. The race is a matter of milliseconds, so the spec runs the same first turn several
 * times in fresh conversations: before the fix about one in four lost its click.
 *
 * The tool is `agent_start` aimed at a machine id that is nobody's: the gate asks first, and
 * the refusal after the click is all the turn needs. A paired device row is what makes the
 * chat offer the tool; no machine runs.
 */
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { test, expect, E2E_APP_BASE, E2E_APP_URL } from "./fixtures";
import { seedUser } from "./machineHarness";

const ROUNDS = 8;

test("an approval answered on a conversation's first turn resumes it, every time", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	test.setTimeout(180_000);
	const userId = await seedUser(db, session.sessionId, `e2e-${randomUUID()}`);
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

	for (let round = 1; round <= ROUNDS; round++) {
		const res = await page.request.post(`${E2E_APP_URL}/conversation`, {
			headers: { origin: E2E_APP_URL, "content-type": "application/json" },
			data: { model: "test-org/test-model" },
		});
		const { conversationId } = (await res.json()) as { conversationId: string };
		await mockOpenAI.setScenario(conversationId, {
			toolCalls: [
				{
					id: `call_${round}`,
					name: "agent_start",
					arguments: JSON.stringify({
						prompt: "x",
						deviceId: "ffffffffffffffffffffffff",
						workspaceId: "w",
					}),
				},
			],
			content: [`Round ${round} done`, "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
		await page.getByPlaceholder("Ask anything").fill("go");
		await page.getByRole("button", { name: "Send message" }).click();
		const last = page.locator('[data-message-role="assistant"]').last();
		await expect(last.getByText("wants to call agent_start")).toBeVisible({ timeout: 60_000 });
		await last.getByRole("button", { name: "Allow once" }).click();
		await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
			`Round ${round} done.`,
			{ timeout: 30_000 }
		);
	}
});
