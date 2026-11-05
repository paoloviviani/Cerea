/** What the cards say: the notes the stream, the inbox and the availability read (ADR 0107). */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { collections, ready } from "$lib/server/database";
import { autoApprovalAvailability } from "$lib/server/agentReview";
import {
	permissionRequestToUpdate,
	permissionResolvedToUpdate,
	withReviewNote,
} from "$lib/server/code/machineTimeline";
import type { PermissionRequest } from "$lib/types/machineProtocol";
import { _resetHealth, noteCallFailed, noteCallOk } from "./health";
import {
	allowedNote,
	belowNote,
	cappedNote,
	onReviewNote,
	ruleNote,
	setReviewNote,
	unavailableNote,
} from "./wording";

const req: PermissionRequest = {
	id: "n1",
	sessionId: "s",
	tool: "bash",
	title: "Run",
	patterns: [],
	metadata: {},
	always: [],
};

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	_resetHealth();
	await collections.agentReviewConfig.deleteMany({});
});

describe("the wording", () => {
	it("is exactly the sentences the ADR gives", () => {
		expect(allowedNote()).toBe("Auto-allowed by reviewer model");
		expect(belowNote(0.51, 0.9)).toBe("The reviewer wasn't sure enough (51%; it allows at 90%)");
		expect(ruleNote("it touches credentials or a secrets file")).toBe(
			"This kind of request always comes to you: it touches credentials or a secrets file"
		);
		expect(unavailableNote()).toBe("The reviewer couldn't be reached, so this comes to you");
		expect(cappedNote()).toMatch(/hourly limit/);
	});
});

describe("on the card", () => {
	it("an auto-allowed ask settles with the note", () => {
		setReviewNote("n1", { text: allowedNote(), allowed: true });
		expect(permissionResolvedToUpdate("n1", "once")).toMatchObject({
			resolution: "user",
			action: "accept",
			note: "Auto-allowed by reviewer model",
		});
		// the user's own rejection is never labelled as the reviewer's
		expect(permissionResolvedToUpdate("n1", "reject").note).toBeUndefined();
	});
	it("an escalated ask carries the reason on its request card, and in the inbox's list", () => {
		setReviewNote("n2", { text: belowNote(0.51, 0.9), allowed: false });
		const ask = { ...req, id: "n2" };
		const update = permissionRequestToUpdate(ask);
		expect(update.request.reviewNote).toBe(
			"The reviewer wasn't sure enough (51%; it allows at 90%)"
		);
		expect(withReviewNote(ask).reviewNote).toContain("51%");
		expect(permissionResolvedToUpdate("n2", "once").note).toBeUndefined();
	});
	it("an ask the reviewer never saw has no note", () => {
		expect(permissionRequestToUpdate({ ...req, id: "never" }).request.reviewNote).toBeUndefined();
		expect(permissionResolvedToUpdate("never", "once").note).toBeUndefined();
	});
});

describe("availability: the reviewer keeps failing", () => {
	it("is degraded after three failures in a row, and a success clears it", async () => {
		await collections.agentReviewConfig.updateOne(
			{},
			{ $set: { enabled: true, decisionModelId: "m" } },
			{ upsert: true }
		);
		expect((await autoApprovalAvailability()).degraded).toBe(false);
		noteCallFailed();
		noteCallFailed();
		expect((await autoApprovalAvailability()).degraded).toBe(false);
		noteCallFailed();
		expect((await autoApprovalAvailability()).degraded).toBe(true);
		noteCallOk();
		expect((await autoApprovalAvailability()).degraded).toBe(false);
	});
});

describe("a note set after the card was announced", () => {
	it("reaches a listener (the stream re-emits the card with it) until it unsubscribes", () => {
		const seen: string[] = [];
		const off = onReviewNote((id, note) => seen.push(`${id}:${note.text}`));
		setReviewNote("late1", { text: belowNote(0.77, 0.9), allowed: false });
		off();
		setReviewNote("late2", { text: "x", allowed: false });
		expect(seen).toEqual(["late1:The reviewer wasn't sure enough (77%; it allows at 90%)"]);
	});
});
