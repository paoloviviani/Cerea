import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	PAGE_APPROVAL_TTL_MS,
	approvalHash,
	consumeApproval,
	issueApproval,
} from "./pageApprovals";

beforeAll(async () => {
	await ready;
});

const created: ObjectId[] = [];
afterEach(async () => {
	await collections.conversations.deleteMany({ _id: { $in: created.splice(0) } });
});

async function conversation() {
	const _id = new ObjectId();
	created.push(_id);
	await collections.conversations.insertOne({
		_id,
		sessionId: "s",
		createdAt: new Date(),
		updatedAt: new Date(),
		messages: [],
	} as never);
	return _id;
}

describe("the approval a page's call waits on", () => {
	it("is spent once, by the call it was issued for", async () => {
		const id = await conversation();
		const hash = approvalHash({ connector: "c", tool: "t", args: { a: 1 } });
		const issued = await issueApproval(id, hash);
		if (!issued.ok) throw new Error("not issued");

		expect(await consumeApproval(id, issued.id, hash)).toBe(true);
		expect(await consumeApproval(id, issued.id, hash)).toBe(false);
	});

	it("is not valid for another call", async () => {
		const id = await conversation();
		const hash = approvalHash({ connector: "c", tool: "t", args: { a: 1 } });
		const issued = await issueApproval(id, hash);
		if (!issued.ok) throw new Error("not issued");

		const other = approvalHash({ connector: "c", tool: "t", args: { a: 2 } });
		expect(await consumeApproval(id, issued.id, other)).toBe(false);
		// The wrong attempt did not spend it.
		expect(await consumeApproval(id, issued.id, hash)).toBe(true);
	});

	it("is not valid for another conversation", async () => {
		const id = await conversation();
		const elsewhere = await conversation();
		const hash = approvalHash({ connector: "c", tool: "t", args: {} });
		const issued = await issueApproval(id, hash);
		if (!issued.ok) throw new Error("not issued");

		expect(await consumeApproval(elsewhere, issued.id, hash)).toBe(false);
	});

	it("allows only one waiting at a time, and frees the slot when spent", async () => {
		const id = await conversation();
		const hash = approvalHash({ connector: "c", tool: "t", args: {} });
		const first = await issueApproval(id, hash);
		if (!first.ok) throw new Error("not issued");

		expect(await issueApproval(id, hash)).toEqual({ ok: false });
		await consumeApproval(id, first.id, hash);
		expect((await issueApproval(id, hash)).ok).toBe(true);
	});

	it("expires: a late click is refused and the slot is free again", async () => {
		const id = await conversation();
		const hash = approvalHash({ connector: "c", tool: "t", args: {} });
		const now = new Date();
		const issued = await issueApproval(id, hash, now);
		if (!issued.ok) throw new Error("not issued");
		const late = new Date(now.getTime() + PAGE_APPROVAL_TTL_MS + 1000);

		expect(await consumeApproval(id, issued.id, hash, late)).toBe(false);
		expect((await issueApproval(id, hash, late)).ok).toBe(true);
	});

	it("binds the user: another user's identical call has another hash", () => {
		const a = approvalHash({ userId: new ObjectId(), connector: "c", tool: "t", args: {} });
		const b = approvalHash({ userId: new ObjectId(), connector: "c", tool: "t", args: {} });
		expect(a).not.toBe(b);
	});
});
