import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import {
	isMessageElicitationRequestUpdate,
	isMessageElicitationResolvedUpdate,
} from "$lib/utils/messageUpdates";

await ready;

const { openFetchApprovalPrompt } = await import("./fetchApproval");

describe("openFetchApprovalPrompt", () => {
	it("records a durable prompt naming the URL and offers once/conversation scopes", async () => {
		const conversationId = new ObjectId();
		const updates: MessageUpdate[] = [];
		const url = "https://unseen.test/some/page";

		const opened = await openFetchApprovalPrompt({
			sink: { conversationId, emit: (u) => updates.push(u) },
			toolUuid: "call-uuid",
			toolCallId: "call-1",
			messageId: "message-1",
			url,
		});

		expect(opened).toEqual({ opened: true });

		const emitted = updates.find(isMessageElicitationRequestUpdate);
		expect(emitted?.request.message).toContain(url);
		expect(emitted?.request.message).toContain("unseen.test");
		expect(emitted?.request.fields?.[0]).toMatchObject({
			kind: "select",
			required: true,
			options: [
				{ value: "once", label: expect.stringContaining("one fetch") },
				{ value: "conversation", label: expect.stringContaining("rest of the conversation") },
			],
		});
		expect(updates.find(isMessageElicitationResolvedUpdate)).toBeUndefined();

		const elicitationId = emitted?.request.elicitationId;
		const stored = await collections.mcpElicitations.findOne({ elicitationId });
		expect(stored?.pending).toEqual({
			kind: "fetch-approval",
			url,
			messageId: "message-1",
			toolCallId: "call-1",
			toolUuid: "call-uuid",
		});
		expect(stored?.status).toBe("pending");
	});

	it("refuses to open a prompt for an unparseable URL", async () => {
		const conversationId = new ObjectId();
		const opened = await openFetchApprovalPrompt({
			sink: { conversationId, emit: () => {} },
			toolUuid: "u",
			toolCallId: "c",
			messageId: "m",
			url: "not a url",
		});
		expect(opened).toEqual({ opened: false, reason: "not a valid URL" });
	});
});
