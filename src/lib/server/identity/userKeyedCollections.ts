/**
 * Every collection (and GridFS bucket) that belongs to one chat account
 * (ADR 0093 §3.3, §7.2, §9.2) — the one registry `mergeChatUsers` (§7.2) and
 * the erasure endpoint (§9.3) both walk, so a person's data is moved or
 * removed in exactly one place rather than by two hand-kept lists that drift.
 *
 * **Ordering is load-bearing.** A GridFS entry that resolves ownership
 * through another collection (a conversation's attachments, a device's
 * `/code` attachment keys) must run before that collection's own entry
 * deletes the rows it reads to find its files — `USER_KEYED_COLLECTIONS` is
 * declared in the order an erasure run must use, and `userKeyedCollections`
 * exports it as a plain array rather than a map for exactly that reason.
 *
 * **Merge is not erasure.** A `merge` moves the stray's rows onto the
 * target and never touches a row already there; an `erase` removes every
 * row belonging to one person and nothing else's.
 *
 * **The unique-index conflicts §7.2 doesn't spell out.** `skills`
 * (`{scope, userId, name}`), `mcpTokens` (`{connectorId, userId}`) and
 * `codeDevices` (`{userId, machineId}`) can each refuse a plain
 * `updateMany` if the stray and the target both hold a row that would
 * collide once reassigned (the same skill name in one scope, a token for
 * the same connector, vanishingly unlikely for `machineId` but not
 * impossible). §7.2 gives a conflict rule for exactly two collections
 * (`memberships`-shaped ones on the gateway side aren't this file's
 * concern; here it's only `settings` and `sessions`). For these three,
 * `reassignWithUniqueConflict` keeps the target's row and drops the
 * stray's — the same "on conflict, keep the target's" judgement §7.1 makes
 * on the gateway side — and this deviation is called out in the worker's
 * report for the design to confirm or override.
 */

import type { Collection, Document, ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { deleteConversationAttachments } from "$lib/server/files/deleteConversationAttachments";
import { deleteAttachmentsByPrefix } from "$lib/server/files/attachmentStore";

export interface UserKeyedCollectionEntry {
	/** The collection name as declared in `database.ts`'s `getCollections()`,
	 * or a `bucket:` pseudo-name for a GridFS-only entry that carries no
	 * collection of its own. */
	name: string;
	/** The field ownership hangs on, or how it's resolved when the
	 * collection (or bucket) carries none directly — documentation, read by
	 * the guard spec's failure messages. */
	owner: string;
	/** §7.2: move the stray's rows onto the target. Returns how many moved
	 * (a conflict that was dropped rather than moved is not counted). */
	merge(stray: ObjectId, target: ObjectId): Promise<number>;
	/** §9.2: remove everything belonging to `userId`. Returns how many rows
	 * (or files) were removed. */
	erase(userId: ObjectId): Promise<number>;
}

function isDuplicateKeyError(err: unknown): boolean {
	return err instanceof Error && /duplicate key/i.test(err.message);
}

/** Move every stray row onto the target, field by field, with no unique
 * index to conflict with. */
async function reassignSimple<T extends Document>(
	collection: Pick<Collection<T>, "updateMany">,
	field: string,
	stray: ObjectId,
	target: ObjectId
): Promise<number> {
	const { modifiedCount } = await collection.updateMany(
		{ [field]: stray } as never,
		{ $set: { [field]: target } } as never
	);
	return modifiedCount;
}

/** The same move, one row at a time, for a collection whose unique index
 * includes the owner field: a row that would collide with one the target
 * already holds is dropped instead (the target's stays). */
async function reassignWithUniqueConflict<T extends Document>(
	collection: Pick<Collection<T>, "find" | "updateOne" | "deleteOne">,
	field: string,
	stray: ObjectId,
	target: ObjectId
): Promise<number> {
	const rows = await collection.find({ [field]: stray } as never).toArray();
	let moved = 0;
	for (const row of rows) {
		try {
			await collection.updateOne({ _id: row._id } as never, { $set: { [field]: target } } as never);
			moved++;
		} catch (err) {
			if (!isDuplicateKeyError(err)) throw err;
			await collection.deleteOne({ _id: row._id } as never);
		}
	}
	return moved;
}

async function eraseByField<T extends Document>(
	collection: Pick<Collection<T>, "deleteMany">,
	field: string,
	userId: ObjectId
): Promise<number> {
	const { deletedCount } = await collection.deleteMany({ [field]: userId } as never);
	return deletedCount;
}

/** Delete every GridFS file (and its chunks) matching a bucket filter, one
 * at a time so a single failure doesn't strand the rest — the same
 * discipline `attachmentStore.ts`'s `deleteMatching` and
 * `deleteConversationAttachments` use. */
async function eraseBucketMatching(filter: Record<string, unknown>): Promise<number> {
	const files = await collections.bucketFiles
		.find(filter)
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	const results = await Promise.all(
		files.map((file) =>
			collections.bucket.delete(file._id).then(
				() => true,
				() => false
			)
		)
	);
	return results.filter(Boolean).length;
}

/**
 * `settings`: the merge keeps the target's row and deletes the stray's
 * (§7.2) rather than reassigning — there is exactly one settings row per
 * account, so "reassign" would mean overwriting whichever account already
 * had one.
 */
async function mergeSettings(stray: ObjectId): Promise<number> {
	const { deletedCount } = await collections.settings.deleteMany({ userId: stray });
	return deletedCount;
}

/** `sessions`: the stray's are deleted outright (§7.2) — a session is a
 * login on a device, not content, and the target keeps its own. */
async function mergeSessionsDelete(stray: ObjectId): Promise<number> {
	const { deletedCount } = await collections.sessions.deleteMany({ userId: stray });
	return deletedCount;
}

export const USER_KEYED_COLLECTIONS: UserKeyedCollectionEntry[] = [
	// GridFS entries first, in every case where they resolve ownership
	// through a collection whose own entry (below) deletes the rows they
	// need to read.
	{
		name: "bucket:conversationFiles",
		owner: "conversations.userId (and sharedConversations.userId, both via metadata.conversation)",
		// Files are tagged by conversation id, which a merge never changes —
		// the conversation's own `userId` reassignment (below) is the whole
		// move.
		merge: async () => 0,
		erase: async (userId) => {
			const ids = await collections.conversations
				.find({ userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			// A shared-conversation copy is tagged with the share's own nanoid
			// id (`routes/conversation/[id]/share/+server.ts`), not the
			// original conversation's — a second id space in the same
			// `metadata.conversation` field, folded into this one entry rather
			// than a fourth bucket, since the tag shape is identical.
			const sharedIds = await collections.sharedConversations
				.find({ userId })
				.project<{ _id: string }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			const tags = [...ids.map((id) => id.toString()), ...sharedIds];
			if (tags.length === 0) return 0;
			const count = await collections.bucketFiles.countDocuments({
				"metadata.conversation": { $in: tags },
			});
			await deleteConversationAttachments(ids);
			if (sharedIds.length > 0) {
				await eraseBucketMatching({ "metadata.conversation": { $in: sharedIds } });
			}
			return count;
		},
	},
	{
		name: "bucket:knowledgeBlobs",
		owner: "metadata.owner (a stringified userId, direct)",
		merge: async (stray, target) => {
			const { modifiedCount } = await collections.bucketFiles.updateMany(
				{ "metadata.owner": stray.toString() },
				{ $set: { "metadata.owner": target.toString() } }
			);
			return modifiedCount;
		},
		erase: async (userId) => eraseBucketMatching({ "metadata.owner": userId.toString() }),
	},
	{
		name: "bucket:codeAttachmentKeys",
		owner: "codeDevices.userId, via the code:<deviceId>:<sessionId> owner key",
		// The key's deviceId doesn't change in a merge, so nothing here moves;
		// the device row's own reassignment (below) is the whole move.
		merge: async () => 0,
		erase: async (userId) => {
			const deviceIds = await collections.codeDevices
				.find({ userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id.toString()));
			let count = 0;
			for (const deviceId of deviceIds) {
				count += await deleteAttachmentsByPrefix(`code:${deviceId}:`);
			}
			return count;
		},
	},
	{
		name: "conversations",
		owner: "userId",
		merge: (stray, target) => reassignSimple(collections.conversations, "userId", stray, target),
		erase: (userId) => eraseByField(collections.conversations, "userId", userId),
	},
	{
		name: "projects",
		owner: "userId",
		merge: (stray, target) => reassignSimple(collections.projects, "userId", stray, target),
		erase: (userId) => eraseByField(collections.projects, "userId", userId),
	},
	{
		name: "assistants",
		owner: "createdById",
		merge: (stray, target) => reassignSimple(collections.assistants, "createdById", stray, target),
		erase: (userId) => eraseByField(collections.assistants, "createdById", userId),
	},
	{
		name: "knowledgeDocuments",
		owner:
			"storeId, via vectorStores.ownerId (indirect: this collection carries no owner field of its own)",
		// A document belongs to its store, and the store's own reassignment
		// (below) is the whole move — nothing here changes.
		merge: async () => 0,
		erase: async (userId) => {
			const storeIds = await collections.vectorStores
				.find({ ownerId: userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			if (storeIds.length === 0) return 0;
			const docs = await collections.knowledgeDocuments
				.find({ storeId: { $in: storeIds } })
				.toArray();
			await Promise.all(
				docs
					.filter((doc) => doc.fileId)
					.map((doc) => collections.bucket.delete(doc.fileId as ObjectId).catch(() => undefined))
			);
			const { deletedCount } = await collections.knowledgeDocuments.deleteMany({
				storeId: { $in: storeIds },
			});
			return deletedCount;
		},
	},
	{
		name: "vectorStores",
		owner: "ownerId",
		merge: (stray, target) => reassignSimple(collections.vectorStores, "ownerId", stray, target),
		erase: (userId) => eraseByField(collections.vectorStores, "ownerId", userId),
	},
	{
		name: "skills",
		owner: "userId",
		// Unique on {scope, userId, name}: a stray's skill can share a name,
		// in the same scope, with one the target already has.
		merge: (stray, target) =>
			reassignWithUniqueConflict(collections.skills, "userId", stray, target),
		erase: (userId) => eraseByField(collections.skills, "userId", userId),
	},
	{
		name: "memories",
		owner: "userId",
		merge: (stray, target) => reassignSimple(collections.memories, "userId", stray, target),
		erase: (userId) => eraseByField(collections.memories, "userId", userId),
	},
	{
		name: "mcpConnectors",
		owner: "userId",
		merge: (stray, target) => reassignSimple(collections.mcpConnectors, "userId", stray, target),
		erase: (userId) => eraseByField(collections.mcpConnectors, "userId", userId),
	},
	{
		name: "mcpTokens",
		owner: "userId",
		// Unique on {connectorId, userId}: the stray and the target can each
		// already hold a token for the same connector.
		merge: (stray, target) =>
			reassignWithUniqueConflict(collections.mcpTokens, "userId", stray, target),
		erase: (userId) => eraseByField(collections.mcpTokens, "userId", userId),
	},
	{
		name: "codeDevices",
		owner: "userId",
		// Unique on {userId, machineId}: a fresh `machineId` is minted per
		// enroll, so a real collision is unlikely rather than impossible.
		merge: (stray, target) =>
			reassignWithUniqueConflict(collections.codeDevices, "userId", stray, target),
		erase: (userId) => eraseByField(collections.codeDevices, "userId", userId),
	},
	{
		name: "codeAudit",
		owner: "userId",
		merge: (stray, target) => reassignSimple(collections.codeAudit, "userId", stray, target),
		erase: (userId) => eraseByField(collections.codeAudit, "userId", userId),
	},
	{
		name: "codeExecutionOutputs",
		owner: "userId",
		merge: (stray, target) =>
			reassignSimple(collections.codeExecutionOutputs, "userId", stray, target),
		erase: async (userId) => {
			const docs = await collections.codeExecutionOutputs.find({ userId }).toArray();
			await Promise.all(
				docs.map((doc) => collections.codeOutputBucket.delete(doc.gridFsId).catch(() => undefined))
			);
			const { deletedCount } = await collections.codeExecutionOutputs.deleteMany({ userId });
			return deletedCount;
		},
	},
	{
		name: "sharedConversations",
		owner: "userId",
		merge: (stray, target) =>
			reassignSimple(collections.sharedConversations, "userId", stray, target),
		erase: (userId) => eraseByField(collections.sharedConversations, "userId", userId),
	},
	{
		name: "reports",
		owner: "createdBy",
		merge: (stray, target) => reassignSimple(collections.reports, "createdBy", stray, target),
		erase: (userId) => eraseByField(collections.reports, "createdBy", userId),
	},
	{
		name: "settings",
		owner: "userId",
		merge: (stray) => mergeSettings(stray),
		erase: (userId) => eraseByField(collections.settings, "userId", userId),
	},
	{
		name: "sessions",
		owner: "userId",
		merge: (stray) => mergeSessionsDelete(stray),
		erase: (userId) => eraseByField(collections.sessions, "userId", userId),
	},
];

/**
 * Collections declared in `database.ts` that carry an owner-shaped field but
 * are deliberately **not** in the registry above, with the reason — so the
 * guard spec can tell "forgotten" from "considered and excluded".
 *
 * All six are live-inference bookkeeping, not chat content: every one is
 * TTL-indexed to expire on its own (from one second, `messageEvents`, to
 * seven days, `parkedCalls`) and none is listed in ADR 0093 §7.2 or §9.2.
 * Reassigning them mid-merge would race whatever turn is in flight; leaving
 * a stray's on erasure leaves at most a few hours of a debugging trace with
 * no content in it, gone on its own TTL. This reading is the worker's, not
 * the design's — flagged in the report for confirmation, since the design
 * does not call these out either way.
 */
export const EXEMPT_FROM_REGISTRY: Record<string, string> = {
	generations: "live/recent inference run bookkeeping, TTL 7 days, not named in §7.2/§9.2",
	turnStates: "live turn-state markers, TTL 7 days, not named in §7.2/§9.2",
	mcpElicitations: "in-flight tool elicitations, TTL 24h, not named in §7.2/§9.2",
	parkedCalls: "in-flight execute_code waits, TTL 7 days, not named in §7.2/§9.2",
	messageEvents: "pub/sub notification rows, TTL 1s, not named in §7.2/§9.2",
	mcpOauthPending: "in-flight OAuth state, TTL by expiresAt (minutes), not named in §7.2/§9.2",
};
