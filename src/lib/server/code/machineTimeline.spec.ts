import { describe, expect, it } from "vitest";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { Envelope, NormalizedEvent, PermissionRequest } from "$lib/types/machineProtocol";
import {
	eventToUpdates,
	foldEnvelopeEvents,
	permissionRequestToUpdate,
	questionRequestedToUpdate,
	type ChildContext,
} from "./machineTimeline";

const child: ChildContext = { childId: "child-1", childTitle: "Researcher" };

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
	return {
		id: "perm-1",
		sessionId: "child-1",
		tool: "bash",
		title: "run tests",
		patterns: [],
		metadata: {},
		always: [],
		...overrides,
	};
}

describe("subagent labelling in machineTimeline", () => {
	it("prefixes a child's permission ask with the subagent title and carries the child session", () => {
		const update = permissionRequestToUpdate(permissionRequest(), child);
		expect(update.type).toBe(MessageUpdateType.Elicitation);
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent Researcher: run tests");
		expect(update.request.childSessionId).toBe("child-1");
		expect(update.request.childTitle).toBe("Researcher");
	});

	it("falls back to a bare Subagent label while the title is unknown", () => {
		const update = permissionRequestToUpdate(permissionRequest(), { childId: "child-1" });
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent: run tests");
	});

	it("leaves the parent's own asks unlabelled and untargeted", () => {
		const update = permissionRequestToUpdate(permissionRequest());
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("run tests");
		expect(update.request.childSessionId).toBeUndefined();
	});

	it("prefixes a child's question the same way, keeping its fields", () => {
		const update = questionRequestedToUpdate(
			{
				requestId: "q-1",
				questions: [
					{
						question: "Which approach?",
						header: "Approach",
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			},
			child
		);
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent Researcher: Which approach?");
		expect(update.request.fields).toHaveLength(1);
		expect(update.request.childSessionId).toBe("child-1");
	});
});

describe("child envelopes in eventToUpdates", () => {
	it("folds a child's part/delta/status into childActivity, never the parent transcript", () => {
		const events: NormalizedEvent[] = [
			{
				kind: "part",
				part: { id: "p1", messageId: "m1", role: "assistant", type: "text", text: "child text" },
			},
			{ kind: "delta", messageId: "m1", partId: "p1", role: "assistant", field: "text", delta: "more" },
			{ kind: "status", status: "busy" },
			{ kind: "status", status: "idle" },
		];
		for (const event of events) {
			const updates = eventToUpdates(event, undefined, undefined, child);
			expect(updates).toEqual([{ type: "childActivity", childId: "child-1" }]);
		}
	});

	it("folds a child's permission ask/resolve and question ask/resolve as labelled cards", () => {
		const asked = eventToUpdates(
			{ kind: "permission.asked", request: permissionRequest() },
			undefined,
			undefined,
			child
		);
		expect(asked).toHaveLength(1);
		expect(JSON.stringify(asked[0])).toContain("Subagent Researcher: run tests");

		const resolved = eventToUpdates(
			{ kind: "permission.replied", requestId: "perm-1", decision: "once", by: "user" },
			undefined,
			undefined,
			child
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].type).toBe(MessageUpdateType.Elicitation);
	});
});

describe("foldEnvelopeEvents with a session tree", () => {
	const envelope = (sessionId: string, event: NormalizedEvent, seq: number): Envelope => ({
		sessionId,
		epoch: "e1",
		seq,
		rootSessionId: "parent-1",
		event,
	});
	const childOf = (sessionId: string): ChildContext | undefined =>
		sessionId === "parent-1" ? undefined : { childId: sessionId, childTitle: "Researcher" };

	it("keeps the child's tokens out of the parent stream and labels its asks", () => {
		const { updates } = foldEnvelopeEvents(
			[
				envelope("child-1", { kind: "status", status: "busy" }, 1),
				envelope(
					"child-1",
					{
						kind: "part",
						part: { id: "p1", messageId: "m1", role: "assistant", type: "text", text: "hi" },
					},
					2
				),
				envelope("child-1", { kind: "permission.asked", request: permissionRequest() }, 3),
				envelope("parent-1", { kind: "status", status: "busy" }, 1),
			],
			undefined,
			undefined,
			childOf
		);
		expect(updates[0]).toEqual({ type: "childActivity", childId: "child-1" });
		expect(updates[1]).toEqual({ type: "childActivity", childId: "child-1" });
		expect(JSON.stringify(updates[2])).toContain("Subagent Researcher: run tests");
		// The parent's own status still folds to a running turn state.
		expect(updates[3]).toMatchObject({ type: MessageUpdateType.TurnState, state: "running" });
	});

	it("never lets a child's message events pollute the parent's tracked state", () => {
		const { lastAssistantError, userMessageIds } = foldEnvelopeEvents(
			[
				envelope(
					"child-1",
					{ kind: "message", message: { id: "cm", role: "assistant", createdAt: "", error: "boom" } },
					1
				),
			],
			undefined,
			undefined,
			childOf
		);
		expect(lastAssistantError).toBeUndefined();
		expect(userMessageIds.size).toBe(0);
	});
});
