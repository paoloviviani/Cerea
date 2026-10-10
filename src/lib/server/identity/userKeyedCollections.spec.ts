import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import {
	type EraseContext,
	previewErasureCounts,
	USER_KEYED_COLLECTIONS,
} from "./userKeyedCollections";

const NO_CONVERSATIONS: EraseContext = { conversationIds: [] };

/**
 * Every collection `database.ts` declares, by name, with whether it carries
 * an owner- or conversation-shaped field — kept here rather than derived by
 * reflection, since nothing at runtime can read a TypeScript interface back.
 * Adding a collection means updating this roster by hand; the point of the
 * tests below is that doing so is the *only* way to keep them green, so a
 * forgotten collection fails loudly here rather than silently missing a
 * merge or an erasure. Every one of these is registered now — none is
 * exempt (ADR 0093 review: several TTL-bound collections hold user content
 * and got their own entries instead).
 */
const ALL_COLLECTIONS: Record<string, boolean> = {
	conversations: true,
	projects: true,
	skills: true,
	customModels: true, // a person's own named model variants; owner-keyed like settings
	memories: true,
	projectMemories: true, // authored by a user; erased with the owning project
	projectDocuments: true, // added by a user; erased (rows and stored files) with the owning project
	vectorStores: true,
	knowledgeDocuments: true, // indirect: via storeId -> vectorStores.ownerId
	knowledgeConfig: false,
	knowledgeConfigHistory: false,
	mcpConnectors: true,
	mcpTokens: true,
	mcpOauthPending: true,
	codeDevices: true,
	codeAudit: true,
	schedules: true, // a person's scheduled actions; owner-keyed, erased and merged with the account
	scheduleRuns: true, // one row per occurrence considered: the record of what a schedule did
	conversationStats: false,
	assistants: true,
	reports: true,
	sharedConversations: true, // ADR 0093 deviation: userId added, see SharedConversation.ts
	abortedGenerations: true, // conversation-keyed, no owner field of its own
	generations: true,
	generationEvents: true, // conversation-keyed, no owner field of its own
	turnStates: true,
	mcpElicitations: true, // conversation-keyed, no owner field of its own
	parkedCalls: true,
	nestedAgentCalls: true, // conversation-keyed, no owner field of its own
	settings: true,
	users: false, // the account itself, not user-keyed content
	sessions: true,
	messageEvents: true,
	bucketFiles: false, // covered by the bucket: entries above
	codeExecutionOutputs: true,
	codeRunFiles: true, // conversation-keyed, no owner field of its own
	migrationResults: false,
	semaphores: false,
	tools: false,
	config: false,
	erasures: false, // the erasure bookkeeping itself, not user content
};

describe("USER_KEYED_COLLECTIONS guard", () => {
	beforeAll(async () => {
		await ready;
	});

	it("has no name known to database.ts left unaccounted for", () => {
		const runtimeNames = Object.keys(collections).filter(
			(name) => name !== "bucket" && name !== "codeOutputBucket"
		);
		const missing = runtimeNames.filter((name) => !(name in ALL_COLLECTIONS));
		expect(missing, "a collection in database.ts has no roster entry here").toEqual([]);
	});

	it("registers every collection that carries an owner or conversation-keyed field", () => {
		const registered = new Set(USER_KEYED_COLLECTIONS.map((e) => e.name));
		const forgotten = Object.entries(ALL_COLLECTIONS)
			.filter(([, needsRule]) => needsRule)
			.map(([name]) => name)
			.filter((name) => !registered.has(name));
		expect(forgotten, "a collection needs a registry entry and has none").toEqual([]);
	});

	it("gives every entry both an explicit merge rule and an explicit erase rule", () => {
		for (const entry of USER_KEYED_COLLECTIONS) {
			expect(entry.mergeRule, `${entry.name} has no mergeRule`).toBeTruthy();
			expect(entry.eraseRule, `${entry.name} has no eraseRule`).toBeTruthy();
		}
	});

	it("has no duplicate entry names", () => {
		const names = USER_KEYED_COLLECTIONS.map((e) => e.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every by-owner(-or-conversation) entry an ownerField, and every custom entry a count()", () => {
		for (const entry of USER_KEYED_COLLECTIONS) {
			if (entry.eraseRule === "by-owner" || entry.eraseRule === "by-owner-or-conversation") {
				expect(entry.ownerField, `${entry.name} needs an ownerField`).toBeTruthy();
			}
			if (entry.eraseRule === "custom") {
				expect(entry.count, `${entry.name} needs its own count()`).toBeTypeOf("function");
			}
		}
	});
});

describe("reassignWithUniqueConflict (mcpTokens, codeDevices: keep the target's)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("mcpTokens: keeps the target's row and drops the stray's on a unique-index collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const connectorId = new ObjectId();
		await collections.mcpConnectors.deleteMany({ _id: connectorId });
		await collections.mcpTokens.deleteMany({ connectorId });
		await collections.mcpTokens.insertMany([
			{
				_id: new ObjectId(),
				connectorId,
				userId: stray,
				accessTokenSealed: "stray-token",
			} as never,
			{
				_id: new ObjectId(),
				connectorId,
				userId: target,
				accessTokenSealed: "target-token",
			} as never,
		]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpTokens");
		if (!entry) throw new Error("mcpTokens must be registered");
		const moved = await entry.merge(stray, target);
		expect(moved).toBe(0);

		const remaining = await collections.mcpTokens.find({ connectorId }).toArray();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].userId.equals(target)).toBe(true);
		expect((remaining[0] as unknown as { accessTokenSealed: string }).accessTokenSealed).toBe(
			"target-token"
		);

		await collections.mcpTokens.deleteMany({ connectorId });
	});

	it("mcpTokens: moves the stray's row when there is no collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const connectorId = new ObjectId();
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId,
			userId: stray,
			accessTokenSealed: "stray-token",
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpTokens");
		if (!entry) throw new Error("mcpTokens must be registered");
		const moved = await entry.merge(stray, target);
		expect(moved).toBe(1);

		const row = await collections.mcpTokens.findOne({ connectorId });
		expect(row?.userId.equals(target)).toBe(true);

		await collections.mcpTokens.deleteMany({ connectorId });
	});

	it("codeDevices: keeps the target's row and drops the stray's on a unique-index collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const machineId = `machine-${new ObjectId().toString()}`;
		const deviceDoc = (userId: ObjectId, suffix: string) => ({
			_id: new ObjectId(),
			userId,
			machineId,
			name: `laptop-${suffix}`,
			status: "paired",
			sub: "sub",
			iss: "iss",
			backends: [],
			policy: {},
			credentialState: "ok",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await collections.codeDevices.insertMany([
			deviceDoc(stray, "stray"),
			deviceDoc(target, "target"),
		] as never);

		// try/finally: a would-be-duplicate (userId, machineId) pair left
		// behind by a failed assertion here would otherwise permanently block
		// this collection's own unique index from ever building on this
		// container — the same index the test exists to prove.
		try {
			const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "codeDevices");
			if (!entry) throw new Error("codeDevices must be registered");
			const moved = await entry.merge(stray, target);
			expect(moved).toBe(0);

			const remaining = await collections.codeDevices.find({ machineId }).toArray();
			expect(remaining).toHaveLength(1);
			expect(remaining[0].userId.equals(target)).toBe(true);
			expect(remaining[0].name).toBe("laptop-target");
		} finally {
			await collections.codeDevices.deleteMany({ machineId });
		}
	});
});

describe("reassignWithRenameOnConflict (skills: rename, never drop)", () => {
	beforeAll(async () => {
		await ready;
	});

	function skillDoc(userId: ObjectId, name: string) {
		return {
			_id: new ObjectId(),
			userId,
			scope: "user" as const,
			name,
			description: "d",
			content: "c",
			enabled: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	it("renames the stray's skill until the name is unique, then reassigns it", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.skills.insertMany([
			skillDoc(stray, "notes"),
			skillDoc(target, "notes"),
		] as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "skills");
		if (!entry) throw new Error("skills must be registered");
		const moved = await entry.merge(stray, target);
		expect(moved).toBe(1);

		const rows = await collections.skills.find({ userId: target, scope: "user" }).toArray();
		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual(["notes", "notes (merged)"]);

		await collections.skills.deleteMany({ userId: { $in: [stray, target] } });
	});

	it("escalates the suffix across more than one collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.skills.insertMany([
			skillDoc(stray, "notes"),
			skillDoc(target, "notes"),
			skillDoc(target, "notes (merged)"),
		] as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "skills");
		if (!entry) throw new Error("skills must be registered");
		await entry.merge(stray, target);

		const rows = await collections.skills.find({ userId: target, scope: "user" }).toArray();
		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual(["notes", "notes (merged 2)", "notes (merged)"]);

		await collections.skills.deleteMany({ userId: { $in: [stray, target] } });
	});

	it("moves the stray's skill unrenamed when there is no collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.skills.insertOne(skillDoc(stray, "recipes") as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "skills");
		if (!entry) throw new Error("skills must be registered");
		await entry.merge(stray, target);

		const row = await collections.skills.findOne({ userId: target, scope: "user" });
		expect(row?.name).toBe("recipes");

		await collections.skills.deleteMany({ userId: { $in: [stray, target] } });
	});
});

describe("customModels: merge renames, erase removes", () => {
	beforeAll(async () => {
		await ready;
	});

	function customModel(userId: ObjectId, name: string) {
		return {
			_id: new ObjectId(),
			userId,
			name,
			nameKey: name.toLowerCase(),
			baseModelId: "test-org/test-model",
			systemPrompt: "p",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	it("renames a stray's model whose name the target already has, moving name and key together", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.customModels.insertMany([
			customModel(stray, "Helper"),
			customModel(target, "helper"),
		]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "customModels");
		if (!entry) throw new Error("customModels must be registered");
		expect(await entry.merge(stray, target)).toBe(1);

		const rows = await collections.customModels.find({ userId: target }).toArray();
		expect(rows.map((r) => r.nameKey).sort()).toEqual(["helper", "helper (merged)"]);
		await collections.customModels.deleteMany({ userId: { $in: [stray, target] } });
	});

	it("erases only the erased person's models", async () => {
		const gone = new ObjectId();
		const kept = new ObjectId();
		await collections.customModels.insertMany([customModel(gone, "A"), customModel(kept, "A")]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "customModels");
		if (!entry) throw new Error("customModels must be registered");
		expect(await entry.erase(gone, NO_CONVERSATIONS)).toBe(1);

		expect(await collections.customModels.countDocuments({ userId: gone })).toBe(0);
		expect(await collections.customModels.countDocuments({ userId: kept })).toBe(1);
		await collections.customModels.deleteMany({ userId: kept });
	});
});

describe("schedules and scheduleRuns: a schedule goes with its person", () => {
	beforeAll(async () => {
		await ready;
	});

	const schedule = (userId: ObjectId) => ({
		_id: new ObjectId(),
		userId,
		kind: "agent" as const,
		name: "Nightly",
		target: {},
		prompt: "p",
		recurrence: { type: "daily" as const, at: "02:00" },
		timezone: "UTC",
		anchorAt: new Date(),
		enabled: true,
		nextRunAt: new Date(),
		consecutiveFailures: 0,
		firedCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const run = (userId: ObjectId, scheduleId: ObjectId) => ({
		_id: new ObjectId(),
		scheduleId,
		userId,
		kind: "agent" as const,
		scheduledFor: new Date(),
		firedAt: new Date(),
		status: "sent" as const,
		trigger: "schedule" as const,
		scheduleName: "Nightly",
	});

	it("erases only the erased person's schedules and their run rows", async () => {
		const gone = new ObjectId();
		const kept = new ObjectId();
		const goneSchedule = schedule(gone);
		const keptSchedule = schedule(kept);
		await collections.schedules.insertMany([goneSchedule, keptSchedule]);
		await collections.scheduleRuns.insertMany([
			run(gone, goneSchedule._id),
			run(kept, keptSchedule._id),
		]);

		const schedulesEntry = USER_KEYED_COLLECTIONS.find((e) => e.name === "schedules");
		const runsEntry = USER_KEYED_COLLECTIONS.find((e) => e.name === "scheduleRuns");
		if (!schedulesEntry || !runsEntry) throw new Error("both must be registered");
		expect(await schedulesEntry.erase(gone, NO_CONVERSATIONS)).toBe(1);
		expect(await runsEntry.erase(gone, NO_CONVERSATIONS)).toBe(1);

		expect(await collections.schedules.countDocuments({ userId: gone })).toBe(0);
		expect(await collections.scheduleRuns.countDocuments({ userId: gone })).toBe(0);
		expect(await collections.schedules.countDocuments({ userId: kept })).toBe(1);
		expect(await collections.scheduleRuns.countDocuments({ userId: kept })).toBe(1);
		await collections.schedules.deleteMany({ userId: kept });
		await collections.scheduleRuns.deleteMany({ userId: kept });
	});

	it("moves a stray's schedules and runs onto the target on a merge", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const row = schedule(stray);
		await collections.schedules.insertOne(row);
		await collections.scheduleRuns.insertOne(run(stray, row._id));

		for (const name of ["schedules", "scheduleRuns"]) {
			const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === name);
			if (!entry) throw new Error(`${name} must be registered`);
			expect(await entry.merge(stray, target)).toBe(1);
		}
		expect(await collections.schedules.countDocuments({ userId: target })).toBe(1);
		expect(await collections.scheduleRuns.countDocuments({ userId: target })).toBe(1);
		expect(await collections.schedules.countDocuments({ userId: stray })).toBe(0);
		await collections.schedules.deleteMany({ userId: target });
		await collections.scheduleRuns.deleteMany({ userId: target });
	});
});

describe("the conversation-keyed entries (by-conversation erase)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("generationEvents: erases by conversation id, follows on merge", async () => {
		const conversationId = new ObjectId();
		const otherConversationId = new ObjectId();
		await collections.generationEvents.insertMany([
			{
				_id: new ObjectId(),
				generationId: "g1",
				conversationId,
				messageId: "m1",
				seq: 1,
				event: { type: "stream", token: "hi" } as never,
				createdAt: new Date(),
			},
			{
				_id: new ObjectId(),
				generationId: "g2",
				conversationId: otherConversationId,
				messageId: "m1",
				seq: 1,
				event: { type: "stream", token: "hi" } as never,
				createdAt: new Date(),
			},
		] as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "generationEvents");
		if (!entry) throw new Error("generationEvents must be registered");
		expect(await entry.merge(new ObjectId(), new ObjectId())).toBe(0);
		const erased = await entry.erase(new ObjectId(), { conversationIds: [conversationId] });
		expect(erased).toBe(1);

		expect(await collections.generationEvents.findOne({ conversationId })).toBeNull();
		expect(
			await collections.generationEvents.findOne({ conversationId: otherConversationId })
		).not.toBeNull();

		await collections.generationEvents.deleteMany({
			conversationId: { $in: [conversationId, otherConversationId] },
		});
	});

	it("nestedAgentCalls, mcpElicitations, abortedGenerations: same pattern", async () => {
		const conversationId = new ObjectId();
		await collections.nestedAgentCalls.insertOne({
			_id: new ObjectId(),
			conversationId,
			label: "sandbox",
			iteration: 1,
			toolName: "t",
			arguments: "{}",
			repeatCount: 1,
			status: "success",
			createdAt: new Date(),
		} as never);
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId: "e1",
			conversationId,
			status: "pending",
			request: { elicitationId: "e1", server: "s", mode: "form", message: "m" },
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await collections.abortedGenerations.insertOne({ conversationId } as never);

		const ctx: EraseContext = { conversationIds: [conversationId] };
		for (const name of ["nestedAgentCalls", "mcpElicitations", "abortedGenerations"]) {
			const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === name);
			if (!entry) throw new Error(`${name} must be registered`);
			expect(await entry.erase(new ObjectId(), ctx)).toBeGreaterThan(0);
		}

		expect(await collections.nestedAgentCalls.findOne({ conversationId })).toBeNull();
		expect(await collections.mcpElicitations.findOne({ conversationId })).toBeNull();
		expect(await collections.abortedGenerations.findOne({ conversationId })).toBeNull();
	});

	it("erases nothing when the erased person had no conversations", async () => {
		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "generationEvents");
		if (!entry) throw new Error("generationEvents must be registered");
		expect(await entry.erase(new ObjectId(), NO_CONVERSATIONS)).toBe(0);
	});
});

describe("turnStates and parkedCalls (reassign on merge, owner-or-conversation on erase)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("turnStates: reassigns userId on merge, erases by owner or by conversation", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const conversationId = new ObjectId();
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId,
			messageId: "m1",
			userId: stray,
			status: "done",
			producerId: "g1",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "turnStates");
		if (!entry) throw new Error("turnStates must be registered");
		expect(await entry.merge(stray, target)).toBe(1);
		expect((await collections.turnStates.findOne({ conversationId }))?.userId?.equals(target)).toBe(
			true
		);

		const erased = await entry.erase(target, { conversationIds: [] });
		expect(erased).toBe(1);
		expect(await collections.turnStates.findOne({ conversationId })).toBeNull();
	});

	it("turnStates: erase also reaches a row with no userId, by conversation id", async () => {
		const conversationId = new ObjectId();
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId,
			messageId: "m1",
			status: "done",
			producerId: "g1",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "turnStates");
		if (!entry) throw new Error("turnStates must be registered");
		const erased = await entry.erase(new ObjectId(), { conversationIds: [conversationId] });
		expect(erased).toBe(1);
		expect(await collections.turnStates.findOne({ conversationId })).toBeNull();
	});

	it("parkedCalls: reassigns userId on merge", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const conversationId = new ObjectId();
		await collections.parkedCalls.insertOne({
			_id: new ObjectId(),
			parkedCallId: `p-${new ObjectId().toString()}`,
			conversationId,
			messageId: "m1",
			toolCallId: "t1",
			toolUuid: "u1",
			kind: "timer",
			status: "waiting",
			resumeAt: new Date(),
			reason: "r",
			userId: stray,
			attempts: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "parkedCalls");
		if (!entry) throw new Error("parkedCalls must be registered");
		expect(await entry.merge(stray, target)).toBe(1);
		expect(
			(await collections.parkedCalls.findOne({ conversationId }))?.userId?.equals(target)
		).toBe(true);

		await collections.parkedCalls.deleteMany({ conversationId });
	});
});

describe("messageEvents and mcpOauthPending (delete-stray on merge, by-owner on erase)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("messageEvents: deletes the stray's rows on merge, keeps the target's", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.messageEvents.insertMany([
			{
				userId: stray,
				expiresAt: new Date(Date.now() + 1000),
				type: "message",
				createdAt: new Date(),
			},
			{
				userId: target,
				expiresAt: new Date(Date.now() + 1000),
				type: "message",
				createdAt: new Date(),
			},
		] as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "messageEvents");
		if (!entry) throw new Error("messageEvents must be registered");
		expect(await entry.merge(stray, target)).toBe(1);
		expect(await collections.messageEvents.findOne({ userId: stray })).toBeNull();
		expect(await collections.messageEvents.findOne({ userId: target })).not.toBeNull();

		await collections.messageEvents.deleteMany({ userId: { $in: [stray, target] } });
	});

	it("mcpOauthPending: deletes the stray's rows on merge", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.mcpOauthPending.insertOne({
			_id: new ObjectId(),
			state: `s-${new ObjectId().toString()}`,
			connectorId: new ObjectId(),
			userId: stray,
			sessionId: "sess",
			verifier: "v",
			next: "/",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 1000),
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpOauthPending");
		if (!entry) throw new Error("mcpOauthPending must be registered");
		expect(await entry.merge(stray, target)).toBe(1);
		expect(await collections.mcpOauthPending.findOne({ userId: stray })).toBeNull();
	});
});

describe("generations (reassign on merge, by-owner on erase)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("reassigns userId on merge and erases by owner", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		await collections.generations.insertOne({
			_id: new ObjectId(),
			generationId: "g1",
			conversationId: new ObjectId(),
			messageId: "m1",
			userId: stray,
			status: "running",
			seq: 0,
			lastHeartbeatAt: new Date(),
			startedAt: new Date(),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "generations");
		if (!entry) throw new Error("generations must be registered");
		expect(await entry.merge(stray, target)).toBe(1);
		expect(
			await collections.generations.findOne({ generationId: "g1", userId: target })
		).not.toBeNull();

		expect(await entry.erase(target, NO_CONVERSATIONS)).toBe(1);
		expect(await collections.generations.findOne({ generationId: "g1" })).toBeNull();
	});
});

describe("the conversationFiles bucket entry", () => {
	beforeAll(async () => {
		await ready;
	});

	// Each upload's "finish" listener is attached BEFORE its end(): the second
	// upload used to get its listener only after the first had been awaited,
	// so when it finished in the meantime the event was already gone and the
	// test hung until its timeout (CI's check job, 2026-10-10, twice).
	it("erases a conversation's attachments and a shared copy's, by owner", async () => {
		const userId = new ObjectId();
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const sharedId = `shared-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: sharedId,
			userId,
			hash: sharedId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const upload = (name: string, conversation: string) => {
			const stream = collections.bucket.openUploadStream(name, { metadata: { conversation } });
			const done = new Promise((resolve, reject) => {
				stream.on("finish", resolve);
				stream.on("error", reject);
			});
			stream.end(Buffer.from("hello"));
			return done;
		};
		await Promise.all([
			upload(`${conversationId}-file`, conversationId.toString()),
			upload(`${sharedId}-file`, sharedId),
		]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "bucket:conversationFiles");
		if (!entry) throw new Error("bucket:conversationFiles must be registered");
		const erased = await entry.erase(userId, { conversationIds: [conversationId] });
		expect(erased).toBe(2);

		const remaining = await collections.bucketFiles
			.find({ "metadata.conversation": { $in: [conversationId.toString(), sharedId] } })
			.toArray();
		expect(remaining).toHaveLength(0);

		await collections.conversations.deleteOne({ _id: conversationId });
		await collections.sharedConversations.deleteOne({ _id: sharedId });
	});
});

describe("previewErasureCounts (the erasure preview's dry run)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("counts what erase would remove, without removing it", async () => {
		const userId = new ObjectId();
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await collections.memories.insertOne({
			_id: new ObjectId(),
			userId,
			content: "remember this",
			createdAt: new Date(),
		} as never);
		await collections.generationEvents.insertOne({
			_id: new ObjectId(),
			generationId: "g1",
			conversationId,
			messageId: "m1",
			seq: 1,
			event: { type: "stream", token: "hi" } as never,
			createdAt: new Date(),
		} as never);

		const ctx: EraseContext = { conversationIds: [conversationId] };
		const counts = await previewErasureCounts(userId, ctx);
		expect(counts.conversations).toBe(1);
		expect(counts.memories).toBe(1);
		expect(counts.generationEvents).toBe(1);

		// Nothing was actually deleted.
		expect(await collections.conversations.findOne({ _id: conversationId })).not.toBeNull();
		expect(await collections.memories.findOne({ userId })).not.toBeNull();
		expect(await collections.generationEvents.findOne({ conversationId })).not.toBeNull();

		// And a real erase afterwards removes exactly what was previewed.
		const conversationsEntry = USER_KEYED_COLLECTIONS.find((e) => e.name === "conversations");
		const memoriesEntry = USER_KEYED_COLLECTIONS.find((e) => e.name === "memories");
		const generationEventsEntry = USER_KEYED_COLLECTIONS.find((e) => e.name === "generationEvents");
		if (!conversationsEntry || !memoriesEntry || !generationEventsEntry) {
			throw new Error("expected entries missing from the registry");
		}
		expect(await conversationsEntry.erase(userId, ctx)).toBe(counts.conversations);
		expect(await memoriesEntry.erase(userId, ctx)).toBe(counts.memories);
		expect(await generationEventsEntry.erase(userId, ctx)).toBe(counts.generationEvents);
	});

	it("has an entry for every registered collection", async () => {
		const counts = await previewErasureCounts(new ObjectId(), { conversationIds: [] });
		expect(Object.keys(counts).sort()).toEqual(USER_KEYED_COLLECTIONS.map((e) => e.name).sort());
	});
});

describe("projectMemories erasure (notes follow the project, not the author)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("deletes notes in projects the person owns, keeps the ones they wrote in other people's, and is previewed accurately", async () => {
		const erased = new ObjectId();
		const other = new ObjectId();
		const mine = new ObjectId();
		const theirs = new ObjectId();
		await collections.projects.deleteMany({ _id: { $in: [mine, theirs] } });
		await collections.projectMemories.deleteMany({ projectId: { $in: [mine, theirs] } });
		const now = new Date();
		await collections.projects.insertMany([
			{ _id: mine, userId: erased, name: "Mine", shares: [], createdAt: now, updatedAt: now },
			{ _id: theirs, userId: other, name: "Theirs", shares: [], createdAt: now, updatedAt: now },
		] as never);
		const row = (projectId: ObjectId, authorUserId: ObjectId, text: string) => ({
			_id: new ObjectId(),
			projectId,
			text,
			source: "user" as const,
			authorUserId,
			createdAt: now,
			updatedAt: now,
		});
		await collections.projectMemories.insertMany([
			row(mine, erased, "Mine, by me."),
			row(mine, other, "Mine, by a colleague."),
			row(theirs, erased, "Theirs, by me."),
			row(theirs, other, "Theirs, by them."),
		]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "projectMemories");
		if (!entry) throw new Error("projectMemories is not registered");
		expect(entry.eraseRule).toBe("custom");
		const counts = await previewErasureCounts(erased, NO_CONVERSATIONS);
		expect(counts.projectMemories).toBe(2);

		expect(await entry.erase(erased, NO_CONVERSATIONS)).toBe(2);
		const left = await collections.projectMemories
			.find({ projectId: { $in: [mine, theirs] } })
			.toArray();
		expect(left.map((r) => r.text).sort()).toEqual(["Theirs, by me.", "Theirs, by them."]);

		// It must run before `projects` removes the rows it reads to find what the person owns.
		const names = USER_KEYED_COLLECTIONS.map((e) => e.name);
		expect(names.indexOf("projectMemories")).toBeLessThan(names.indexOf("projects"));

		// A merge moves authorship onto the target.
		const target = new ObjectId();
		expect(await entry.merge(erased, target)).toBe(1);
		expect(
			await collections.projectMemories.countDocuments({ projectId: theirs, authorUserId: target })
		).toBe(1);
	});
});

describe("projectDocuments erasure (documents follow the project, not the uploader)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("deletes rows and stored files in projects the person owns, keeps what they added elsewhere, and previews it", async () => {
		const erased = new ObjectId();
		const other = new ObjectId();
		const mine = new ObjectId();
		const theirs = new ObjectId();
		const now = new Date();
		await collections.projects.deleteMany({ _id: { $in: [mine, theirs] } });
		await collections.projectDocuments.deleteMany({ projectId: { $in: [mine, theirs] } });
		await collections.projects.insertMany([
			{ _id: mine, userId: erased, name: "Mine", shares: [], createdAt: now, updatedAt: now },
			{ _id: theirs, userId: other, name: "Theirs", shares: [], createdAt: now, updatedAt: now },
		] as never);
		const docs = [
			{ projectId: mine, by: erased },
			{ projectId: mine, by: other },
			{ projectId: theirs, by: erased },
			{ projectId: theirs, by: other },
		].map(({ projectId, by }, i) => ({
			_id: new ObjectId(),
			projectId,
			name: `d${i}`,
			mime: "text/plain",
			bytes: 1,
			sha: `sha${i}`,
			chars: 1,
			status: "ready" as const,
			addedByUserId: by,
			createdAt: now,
			updatedAt: now,
		}));
		await collections.projectDocuments.insertMany(docs);
		for (const projectId of [mine, theirs]) {
			const upload = collections.bucket.openUploadStream(`project:${projectId}-x`, {
				metadata: { conversation: `project:${projectId}`, messageId: "m" },
			});
			upload.end(Buffer.from("b"));
			await new Promise((resolve) => upload.once("finish", resolve));
		}

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "projectDocuments");
		if (!entry) throw new Error("projectDocuments is not registered");
		expect(entry.eraseRule).toBe("custom");
		expect((await previewErasureCounts(erased, NO_CONVERSATIONS)).projectDocuments).toBe(2);

		expect(await entry.erase(erased, NO_CONVERSATIONS)).toBe(2);
		const left = await collections.projectDocuments
			.find({ projectId: { $in: [mine, theirs] } })
			.toArray();
		expect(left.map((r) => r.name).sort()).toEqual(["d2", "d3"]);
		expect(
			await collections.bucketFiles.countDocuments({ "metadata.conversation": `project:${mine}` })
		).toBe(0);
		expect(
			await collections.bucketFiles.countDocuments({ "metadata.conversation": `project:${theirs}` })
		).toBe(1);

		const names = USER_KEYED_COLLECTIONS.map((e) => e.name);
		expect(names.indexOf("projectDocuments")).toBeLessThan(names.indexOf("projects"));

		const target = new ObjectId();
		expect(await entry.merge(erased, target)).toBe(1);
		await collections.bucketFiles.deleteMany({ "metadata.conversation": `project:${theirs}` });
	});
});
