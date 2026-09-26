/**
 * `resolvePersonUserIds`, `previewErasure` and `runErasure` (ADR 0093 §9.3).
 * `dropMachineConnection` is mocked: closing a real live link is
 * `machines.spec.ts`'s job (§4.7's revalidation tick uses the exact same
 * call), this file only asserts it's invoked for the right device ids.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";

const dropMachineConnection = vi.fn();
vi.mock("$lib/server/code/machines", () => ({
	dropMachineConnection: (...args: unknown[]) => dropMachineConnection(...args),
}));

const { previewErasure, resolvePersonUserIds, runErasure } = await import("./erasure");

let insertedUserIds: ObjectId[] = [];
let insertedConversationIds: ObjectId[] = [];
let insertedErasureIds: string[] = [];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	vi.clearAllMocks();
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	await collections.conversations.deleteMany({ _id: { $in: insertedConversationIds } });
	await collections.erasures.deleteMany({ _id: { $in: insertedErasureIds } });
	insertedUserIds = [];
	insertedConversationIds = [];
	insertedErasureIds = [];
});

async function makeUser(fields: Partial<import("$lib/types/User").User>) {
	const doc = {
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "n",
		hfUserId: new ObjectId().toString(),
		...fields,
	};
	await collections.users.insertOne(doc as never);
	insertedUserIds.push(doc._id);
	return doc;
}

describe("resolvePersonUserIds", () => {
	it("resolves the direct target, a legacy stray, and a stray mid-merge", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const target = await makeUser({ gatewayUserId });
		const legacyStray = await makeUser({
			issuer: "https://old.example.org",
			hfUserId: "old-sub",
		});
		const midMerge = await makeUser({ mergedInto: target._id, mergeState: "moving" });

		const ids = await resolvePersonUserIds(gatewayUserId, [
			{ issuer: "https://old.example.org", subject: "old-sub" },
		]);
		const idStrings = ids.map((id) => id.toString()).sort();
		expect(idStrings).toEqual(
			[target._id, legacyStray._id, midMerge._id].map((id) => id.toString()).sort()
		);
	});

	it("resolves to nothing for a gateway id the chat has never seen", async () => {
		const ids = await resolvePersonUserIds(`gw-${new ObjectId()}`, []);
		expect(ids).toHaveLength(0);
	});
});

describe("previewErasure", () => {
	it("counts without deleting, and flags unattributed legacy shares", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const user = await makeUser({ gatewayUserId });
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: user._id,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		insertedConversationIds.push(conversationId);

		const legacyShareId = `share-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: legacyShareId,
			hash: legacyShareId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
			// no userId: a legacy, unattributed share
		} as never);

		const preview = await previewErasure(gatewayUserId, []);
		expect(preview.counts.conversations).toBe(1);
		expect(preview.counts.users).toBe(1);
		expect(preview.unattributedLegacyShares).toBeGreaterThanOrEqual(1);

		expect(await collections.conversations.findOne({ _id: conversationId })).not.toBeNull();
		expect(await collections.users.findOne({ _id: user._id })).not.toBeNull();

		await collections.sharedConversations.deleteOne({ _id: legacyShareId });
	});

	it("counts zero everywhere for an unknown gateway id", async () => {
		const preview = await previewErasure(`gw-${new ObjectId()}`, []);
		expect(preview.counts.users).toBe(0);
		expect(preview.counts.conversations).toBe(0);
	});
});

describe("runErasure", () => {
	it("erases every registry collection, the account row, and closes device links", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const user = await makeUser({ gatewayUserId });
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: user._id,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await collections.memories.insertOne({
			_id: new ObjectId(),
			userId: user._id,
			content: "c",
			createdAt: new Date(),
		} as never);
		const deviceId = new ObjectId();
		await collections.codeDevices.insertOne({
			_id: deviceId,
			userId: user._id,
			machineId: `m-${new ObjectId()}`,
			name: "laptop",
			status: "paired",
			sub: "sub",
			iss: "iss",
			backends: [],
			policy: {},
			credentialState: "ok",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const erasureId = `erasure-${new ObjectId()}`;
		insertedErasureIds.push(erasureId);
		const result = await runErasure(erasureId, gatewayUserId, []);

		expect(result.counts.conversations).toBe(1);
		expect(result.counts.memories).toBe(1);
		expect(result.counts.codeDevices).toBe(1);
		expect(result.counts.users).toBe(1);

		expect(await collections.conversations.findOne({ _id: conversationId })).toBeNull();
		expect(await collections.memories.findOne({ userId: user._id })).toBeNull();
		expect(await collections.codeDevices.findOne({ _id: deviceId })).toBeNull();
		expect(await collections.users.findOne({ _id: user._id })).toBeNull();

		expect(dropMachineConnection).toHaveBeenCalledWith(
			deviceId.toString(),
			4403,
			expect.any(String)
		);

		const record = await collections.erasures.findOne({ _id: erasureId });
		expect(record?.doneAt).toBeInstanceOf(Date);
		expect(record?.counts.conversations).toBe(1);
	});

	it("is idempotent: a repeat after doneAt returns the recorded counts and touches nothing", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		await makeUser({ gatewayUserId });
		const erasureId = `erasure-${new ObjectId()}`;
		insertedErasureIds.push(erasureId);

		const first = await runErasure(erasureId, gatewayUserId, []);
		expect(first.counts.users).toBe(1);

		// A second, unrelated account exists now; the erasure must not touch it
		// even though a fresh resolution of the same gateway_user_id would find
		// nothing (the target is already gone) — a repeat must not re-resolve.
		const decoy = await makeUser({ gatewayUserId });

		const second = await runErasure(erasureId, gatewayUserId, []);
		expect(second).toEqual(first);
		expect(await collections.users.findOne({ _id: decoy._id })).not.toBeNull();
	});

	it("resumes from the ids recorded at the start, not a fresh resolution", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const user = await makeUser({ gatewayUserId });
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: user._id,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const erasureId = `erasure-${new ObjectId()}`;
		insertedErasureIds.push(erasureId);
		// Simulates a crash right after the "resolve, then persist" step: the
		// record exists, with the ids already resolved, but nothing erased yet.
		await collections.erasures.insertOne({
			_id: erasureId,
			gatewayUserId,
			identities: [],
			userIds: [user._id.toString()],
			conversationIds: [conversationId.toString()],
			deviceIds: [],
			startedAt: new Date(),
			doneAt: null,
			counts: {},
		});

		// A different (bogus) gateway_user_id on the resume call: if this were
		// used to re-resolve, nothing would be found and nothing erased.
		const result = await runErasure(erasureId, "gw-wrong-on-resume", []);
		expect(result.counts.conversations).toBe(1);
		expect(await collections.conversations.findOne({ _id: conversationId })).toBeNull();
		expect(await collections.users.findOne({ _id: user._id })).toBeNull();
	});
});
