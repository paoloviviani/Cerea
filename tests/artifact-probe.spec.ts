import { test, expect } from "./fixtures.ts";

test("probe artifact updates via API", async ({ api, mockOpenAI, db, session }) => {
	await db.collection("settings").updateOne(
		{ sessionId: session.sessionId },
		{ $set: { activeModel: "test-org/artifact-tool" } }
	);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_probe",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "probe-doc",
					type: "markdown",
					title: "Probe",
					content: "# Probe\n\nhello\n",
				}),
			},
		],
		content: ["Done", "."],
		chunkDelayMs: 50,
		toolCallArgChunkSize: 30,
	});
	const { conversationId, rootMessageId } = await api.createConversation({
		model: "test-org/artifact-tool",
	});
	const updates = await api.sendMessage({
		conversationId,
		parentId: rootMessageId,
		content: "probe",
	});
	const types = updates.map((u) => u.type);
	console.log("UPDATE TYPES:", JSON.stringify(types));
	console.log(
		"DRAFTS:",
		JSON.stringify(updates.filter((u) => u.type === "artifactDraft")).slice(0, 600)
	);
	expect(types).toContain("artifactDraft");
});
