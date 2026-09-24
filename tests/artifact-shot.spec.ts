import { test, E2E_APP_BASE } from "./fixtures.ts";

test("screenshot mid-stream draft", async ({ page, mockOpenAI, db, session }) => {
	await db.collection("settings").updateOne(
		{ sessionId: session.sessionId },
		{ $set: { activeModel: "test-org/artifact-tool" } }
	);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_shot",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "shot-doc",
					type: "markdown",
					title: "Shot Doc",
					content: `# Shot\n\n${"Filler line.\n".repeat(200)}END\n`,
				}),
			},
		],
		content: ["Done", "."],
		chunkDelayMs: 120,
		toolCallArgChunkSize: 40,
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("take a screenshot midstream");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await page.waitForTimeout(4000);
	await page.screenshot({ path: "/tmp/midstream.png" });
	await page.waitForTimeout(9000);
	await page.screenshot({ path: "/tmp/poststream.png" });
});
