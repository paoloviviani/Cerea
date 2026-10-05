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
 * **Every entry carries an explicit rule kind**, on both sides, so the guard
 * spec can fail loudly on a collection that has a function but no declared
 * intent (a copy-paste of the wrong helper) rather than only on a collection
 * with no entry at all:
 *
 * - `merge`: `reassign` (a plain field move), `reassign-unique-keep-target`
 *   (same, but the owner field is part of a unique index — a colliding
 *   stray row is dropped, the target's kept), `reassign-unique-rename`
 *   (same conflict, but the row is content that must not be lost — renamed
 *   until unique instead of dropped), `keep-target-delete-stray` (one row
 *   per account; the target's survives), `delete-stray` (the stray's rows
 *   are discarded outright, nothing to keep), `follows-conversation` (the
 *   rows are keyed by `conversationId`, which a merge never changes — the
 *   conversation's own reassignment is the whole move), `no-op` (ownership
 *   is inherited from some other reassigned parent — a knowledge store, a
 *   device row — for a reason `follows-conversation` doesn't name).
 * - `erase`: `by-owner` (delete by the direct field), `by-conversation`
 *   (delete using the erased person's conversation ids, supplied by the
 *   caller via `EraseContext` — see below), `by-owner-or-conversation`
 *   (both signals are checked, for a collection where the owner field is
 *   optional but the conversation link is not, or vice versa), `custom`
 *   (the GridFS entries and `knowledgeDocuments`, whose ownership is
 *   indirect enough that neither of the above says anything on its own).
 *
 * **`EraseContext.conversationIds`.** A `by-conversation` (or
 * `by-owner-or-conversation`) entry cannot look up "this person's
 * conversations" itself once the `conversations` entry has already run —
 * the erasure endpoint (§9.3) records the id list in the `erasures`
 * document *before* deleting anything, then passes it to every entry's
 * `erase`, so a resumed run still knows what to sweep even after the
 * conversations themselves are gone. `mergeChatUsers` never calls `erase`
 * at all, so this only matters for the (not yet built) erasure endpoint.
 */

import type { Collection, Document, ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { deleteConversationAttachments } from "$lib/server/files/deleteConversationAttachments";
import { conversationSourceRef, deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { deleteAttachmentsByPrefix } from "$lib/server/files/attachmentStore";

export type MergeRuleKind =
	| "reassign"
	| "reassign-unique-keep-target"
	| "reassign-unique-rename"
	| "keep-target-delete-stray"
	| "delete-stray"
	| "follows-conversation"
	| "no-op";

export type EraseRuleKind = "by-owner" | "by-conversation" | "by-owner-or-conversation" | "custom";

export interface EraseContext {
	/** The erased person's own conversation ids, resolved once by the caller
	 * before anything is deleted (§9.3). Entries whose `eraseRule` is
	 * `by-conversation` or `by-owner-or-conversation` use this instead of
	 * querying `conversations` themselves. */
	conversationIds: ObjectId[];
}

export interface UserKeyedCollectionEntry {
	/** The collection name as declared in `database.ts`'s `getCollections()`,
	 * or a `bucket:` pseudo-name for a GridFS-only entry that carries no
	 * collection of its own. */
	name: string;
	/** The field ownership hangs on, or how it's resolved when the
	 * collection (or bucket) carries none directly — documentation, read by
	 * the guard spec's failure messages. */
	owner: string;
	mergeRule: MergeRuleKind;
	eraseRule: EraseRuleKind;
	/** The Mongo field `eraseRule: "by-owner"`/`"by-owner-or-conversation"`
	 * matches on — set on exactly those entries, and read generically by
	 * `previewErasureCounts` so a dry run needs no per-entry duplication. */
	ownerField?: string;
	/** §7.2: move the stray's rows onto the target. Returns how many moved
	 * (a conflict that was dropped rather than moved is not counted;
	 * renamed-and-moved is counted). */
	merge(stray: ObjectId, target: ObjectId): Promise<number>;
	/** §9.2: remove everything belonging to `userId`. Returns how many rows
	 * (or files) were removed. */
	erase(userId: ObjectId, ctx: EraseContext): Promise<number>;
	/** A non-destructive count of what `erase` would remove, for the erasure
	 * preview (§9.3's "dry run"). Required only for `eraseRule: "custom"` —
	 * `previewErasureCounts` derives the rest generically from `eraseRule`
	 * and `ownerField`. */
	count?: (userId: ObjectId, ctx: EraseContext) => Promise<number>;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** The same move, one row at a time, for a collection where the colliding
 * row is content the merge must not lose (`skills`): rather than dropping
 * the stray's row on a unique-index conflict, its `nameField` is suffixed
 * " (merged)", then " (merged 2)" and so on until the move succeeds. */
async function reassignWithRenameOnConflict<T extends Document>(
	collection: Pick<Collection<T>, "find" | "updateOne">,
	field: string,
	nameField: string,
	stray: ObjectId,
	target: ObjectId
): Promise<number> {
	const rows = await collection.find({ [field]: stray } as never).toArray();
	let moved = 0;
	for (const row of rows) {
		const baseName = (row as Record<string, unknown>)[nameField] as string;
		let name = baseName;
		let suffix = 0;
		for (;;) {
			try {
				await collection.updateOne(
					{ _id: row._id } as never,
					{ $set: { [field]: target, [nameField]: name } } as never
				);
				moved++;
				break;
			} catch (err) {
				if (!isDuplicateKeyError(err)) throw err;
				suffix++;
				if (suffix > 1000) {
					throw new Error(
						`reassignWithRenameOnConflict: no unique name for "${baseName}" after 1000 attempts`
					);
				}
				name = suffix === 1 ? `${baseName} (merged)` : `${baseName} (merged ${suffix})`;
			}
		}
	}
	return moved;
}

async function ownedProjectIds(userId: ObjectId): Promise<ObjectId[]> {
	const rows = await collections.projects
		.find({ userId })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	return rows.map((row) => row._id);
}

async function eraseByField<T extends Document>(
	collection: Pick<Collection<T>, "deleteMany">,
	field: string,
	userId: ObjectId
): Promise<number> {
	const { deletedCount } = await collection.deleteMany({ [field]: userId } as never);
	return deletedCount;
}

/** Erase a collection keyed by `conversationId`, using the caller-supplied
 * id list rather than looking accounts up itself (see `EraseContext`). */
async function eraseByConversation<T extends Document>(
	collection: Pick<Collection<T>, "deleteMany">,
	ctx: EraseContext
): Promise<number> {
	if (ctx.conversationIds.length === 0) return 0;
	const { deletedCount } = await collection.deleteMany({
		conversationId: { $in: ctx.conversationIds },
	} as never);
	return deletedCount;
}

/** Both signals checked, for a collection where the owner field is only
 * sometimes present (turnStates, parkedCalls: denormalised for a
 * user-scoped query, but not written for a session-only chat) while
 * `conversationId` always is. A row can never legitimately match one but
 * not the other for a *different* person's data: a merge reassigns both
 * together (see `reassign` below), so this is belt-and-suspenders
 * completeness, not two independent sources of truth. */
async function eraseByOwnerOrConversation<T extends Document>(
	collection: Pick<Collection<T>, "deleteMany">,
	field: string,
	userId: ObjectId,
	ctx: EraseContext
): Promise<number> {
	const or: Record<string, unknown>[] = [{ [field]: userId }];
	if (ctx.conversationIds.length > 0) {
		or.push({ conversationId: { $in: ctx.conversationIds } });
	}
	const { deletedCount } = await collection.deleteMany({ $or: or } as never);
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

/** `sessions`, `messageEvents`, `mcpOauthPending`: the stray's rows are
 * deleted outright — a session, a rate-limit bookkeeping row, or an
 * in-flight OAuth handshake isn't content the merge would need to carry
 * over, and the target keeps its own. */
async function deleteStrayRows<T extends Document>(
	collection: Pick<Collection<T>, "deleteMany">,
	field: string,
	stray: ObjectId
): Promise<number> {
	const { deletedCount } = await collection.deleteMany({ [field]: stray } as never);
	return deletedCount;
}

export const USER_KEYED_COLLECTIONS: UserKeyedCollectionEntry[] = [
	// GridFS entries first, in every case where they resolve ownership
	// through a collection whose own entry (below) deletes the rows they
	// need to read.
	{
		name: "bucket:conversationFiles",
		owner: "conversations.userId (and sharedConversations.userId, both via metadata.conversation)",
		mergeRule: "follows-conversation",
		eraseRule: "custom",
		// Files are tagged by conversation id, which a merge never changes —
		// the conversation's own `userId` reassignment (below) is the whole
		// move.
		merge: async () => 0,
		erase: async (userId, ctx) => {
			// A shared-conversation copy is tagged with the share's own nanoid
			// id (`routes/conversation/[id]/share/+server.ts`), not the
			// original conversation's — a second id space in the same
			// `metadata.conversation` field, folded into this one entry rather
			// than a fourth bucket, since the tag shape is identical. Still
			// self-queried (not from `ctx`): `sharedConversations` runs after
			// this entry and isn't erased yet.
			const sharedIds = await collections.sharedConversations
				.find({ userId })
				.project<{ _id: string }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			const tags = [...ctx.conversationIds.map((id) => id.toString()), ...sharedIds];
			if (tags.length === 0) return 0;
			const count = await collections.bucketFiles.countDocuments({
				"metadata.conversation": { $in: tags },
			});
			await deleteConversationAttachments(ctx.conversationIds);
			if (sharedIds.length > 0) {
				await eraseBucketMatching({ "metadata.conversation": { $in: sharedIds } });
			}
			return count;
		},
		count: async (userId, ctx) => {
			const sharedIds = await collections.sharedConversations
				.find({ userId })
				.project<{ _id: string }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			const tags = [...ctx.conversationIds.map((id) => id.toString()), ...sharedIds];
			if (tags.length === 0) return 0;
			return collections.bucketFiles.countDocuments({ "metadata.conversation": { $in: tags } });
		},
	},
	{
		name: "bucket:knowledgeBlobs",
		owner: "metadata.owner (a stringified userId, direct)",
		mergeRule: "reassign",
		eraseRule: "custom",
		merge: async (stray, target) => {
			const { modifiedCount } = await collections.bucketFiles.updateMany(
				{ "metadata.owner": stray.toString() },
				{ $set: { "metadata.owner": target.toString() } }
			);
			return modifiedCount;
		},
		erase: async (userId) => eraseBucketMatching({ "metadata.owner": userId.toString() }),
		count: async (userId) =>
			collections.bucketFiles.countDocuments({ "metadata.owner": userId.toString() }),
	},
	{
		name: "bucket:codeAttachmentKeys",
		owner: "codeDevices.userId, via the code:<deviceId>:<sessionId> owner key",
		mergeRule: "no-op",
		eraseRule: "custom",
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
		count: async (userId) => {
			const deviceIds = await collections.codeDevices
				.find({ userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id.toString()));
			let count = 0;
			for (const deviceId of deviceIds) {
				const prefix = `code:${deviceId}:`;
				count += await collections.bucketFiles.countDocuments({
					"metadata.conversation": { $regex: `^${escapeRegExp(prefix)}` },
				});
			}
			return count;
		},
	},
	{
		name: "conversations",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.conversations, "userId", stray, target),
		erase: (userId) => eraseByField(collections.conversations, "userId", userId),
	},
	{
		name: "projectMemories",
		owner: "authorUserId (erase: the owning project's userId)",
		// A merge moves the stray's authorship onto the target. The notes in
		// projects the stray *owned* need nothing: `projects` reassigns the
		// project and its notes follow by `projectId`.
		mergeRule: "reassign",
		eraseRule: "custom",
		merge: (stray, target) =>
			reassignSimple(collections.projectMemories, "authorUserId", stray, target),
		// Notes in projects this person owns go with the project (user decision
		// 2). Notes they wrote in projects owned by somebody else are the
		// project's knowledge by now and stay; the author then reads as "deleted
		// user" because the account row is gone (see `projectMemoryViews`). That
		// is why this is not `by-owner` on `authorUserId`, and why it must run
		// *before* the `projects` entry below deletes the rows it reads.
		erase: async (userId) => {
			const owned = await ownedProjectIds(userId);
			if (owned.length === 0) return 0;
			const { deletedCount } = await collections.projectMemories.deleteMany({
				projectId: { $in: owned },
			});
			return deletedCount;
		},
		count: async (userId) => {
			const owned = await ownedProjectIds(userId);
			return owned.length === 0
				? 0
				: collections.projectMemories.countDocuments({ projectId: { $in: owned } });
		},
	},
	{
		name: "projects",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.projects, "userId", stray, target),
		erase: (userId) => eraseByField(collections.projects, "userId", userId),
	},
	{
		name: "assistants",
		owner: "createdById",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "createdById",
		merge: (stray, target) => reassignSimple(collections.assistants, "createdById", stray, target),
		erase: (userId) => eraseByField(collections.assistants, "createdById", userId),
	},
	{
		name: "knowledgeDocuments",
		owner:
			"storeId, via vectorStores.ownerId (indirect: this collection carries no owner field of its own)",
		mergeRule: "no-op",
		eraseRule: "custom",
		// A document belongs to its store, and the store's own reassignment
		// (below) is the whole move — nothing here changes.
		merge: async () => 0,
		// Through `deleteDerived`, which clears the Postgres passages (text and
		// vectors — the erasure promise covers them, not just their
		// retrievability), then the GridFS bytes, then the rows. It runs here,
		// before the `vectorStores` entry below: the store ids it needs are
		// that entry's rows. The erased person's own conversations are swept
		// too, for transcripts of theirs written into a base somebody else owns.
		erase: async (userId, ctx) => {
			const storeIds = await collections.vectorStores
				.find({ ownerId: userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			const { documents } = await deleteDerived({
				storeIds,
				conversationId: ctx.conversationIds,
			});
			return documents;
		},
		count: async (userId, ctx) => {
			const storeIds = await collections.vectorStores
				.find({ ownerId: userId })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((rows) => rows.map((r) => r._id));
			const refs = ctx.conversationIds.map(conversationSourceRef);
			const clauses: Record<string, unknown>[] = [];
			if (storeIds.length > 0) clauses.push({ storeId: { $in: storeIds } });
			if (refs.length > 0) clauses.push({ sourceRef: { $in: refs } });
			if (clauses.length === 0) return 0;
			return collections.knowledgeDocuments.countDocuments({ $or: clauses });
		},
	},
	{
		name: "vectorStores",
		owner: "ownerId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "ownerId",
		merge: (stray, target) => reassignSimple(collections.vectorStores, "ownerId", stray, target),
		erase: (userId) => eraseByField(collections.vectorStores, "ownerId", userId),
	},
	{
		name: "skills",
		owner: "userId",
		mergeRule: "reassign-unique-rename",
		eraseRule: "by-owner",
		ownerField: "userId",
		// Unique on {scope, userId, name}: a stray's skill can share a name,
		// in the same scope, with one the target already has. Unlike
		// mcpTokens/codeDevices this is content, not a credential or a
		// pairing record, so a conflict is resolved by renaming rather than
		// dropping (the orchestrator's decision).
		merge: (stray, target) =>
			reassignWithRenameOnConflict(collections.skills, "userId", "name", stray, target),
		erase: (userId) => eraseByField(collections.skills, "userId", userId),
	},
	{
		name: "memories",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.memories, "userId", stray, target),
		erase: (userId) => eraseByField(collections.memories, "userId", userId),
	},
	{
		name: "mcpConnectors",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.mcpConnectors, "userId", stray, target),
		erase: (userId) => eraseByField(collections.mcpConnectors, "userId", userId),
	},
	{
		name: "mcpTokens",
		owner: "userId",
		mergeRule: "reassign-unique-keep-target",
		eraseRule: "by-owner",
		ownerField: "userId",
		// Unique on {connectorId, userId}: the stray and the target can each
		// already hold a token for the same connector. A credential, not
		// content — the target's stays, the stray's duplicate is dropped.
		merge: (stray, target) =>
			reassignWithUniqueConflict(collections.mcpTokens, "userId", stray, target),
		erase: (userId) => eraseByField(collections.mcpTokens, "userId", userId),
	},
	{
		name: "codeDevices",
		owner: "userId",
		mergeRule: "reassign-unique-keep-target",
		eraseRule: "by-owner",
		ownerField: "userId",
		// Unique on {userId, machineId}: a fresh `machineId` is minted per
		// enroll, so a real collision is unlikely rather than impossible. A
		// pairing record, not content — the device simply re-links.
		merge: (stray, target) =>
			reassignWithUniqueConflict(collections.codeDevices, "userId", stray, target),
		erase: (userId) => eraseByField(collections.codeDevices, "userId", userId),
	},
	{
		name: "codeAudit",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.codeAudit, "userId", stray, target),
		erase: (userId) => eraseByField(collections.codeAudit, "userId", userId),
	},
	{
		name: "codeExecutionOutputs",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
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
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray, target) =>
			reassignSimple(collections.sharedConversations, "userId", stray, target),
		erase: (userId) => eraseByField(collections.sharedConversations, "userId", userId),
	},
	{
		name: "reports",
		owner: "createdBy",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "createdBy",
		merge: (stray, target) => reassignSimple(collections.reports, "createdBy", stray, target),
		erase: (userId) => eraseByField(collections.reports, "createdBy", userId),
	},
	{
		name: "settings",
		owner: "userId",
		mergeRule: "keep-target-delete-stray",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray) => mergeSettings(stray),
		erase: (userId) => eraseByField(collections.settings, "userId", userId),
	},
	{
		name: "sessions",
		owner: "userId",
		mergeRule: "delete-stray",
		eraseRule: "by-owner",
		ownerField: "userId",
		merge: (stray) => deleteStrayRows(collections.sessions, "userId", stray),
		erase: (userId) => eraseByField(collections.sessions, "userId", userId),
	},
	// Live-inference bookkeeping (ADR 0093 review: not exempt — several hold
	// user content: generationEvents.event is the streamed output,
	// mcpElicitations carries the request and the answer, parkedCalls the
	// code and its outcome, nestedAgentCalls its tool arguments, and
	// generations.error a failure message). TTL indexes still bound how long
	// any of this survives on its own; the registry entries are what make an
	// explicit erasure (and a merge that shouldn't lose an in-flight turn)
	// correct rather than incidental.
	{
		name: "generations",
		owner: "userId",
		mergeRule: "reassign",
		eraseRule: "by-owner",
		ownerField: "userId",
		// Reassigned, not left behind: an in-flight generation may still be
		// running when a merge lands, and the resumed/heartbeating writer
		// looks it up by conversation, not by owner — but the owner is kept
		// current for the per-user live feed.
		merge: (stray, target) => reassignSimple(collections.generations, "userId", stray, target),
		erase: (userId) => eraseByField(collections.generations, "userId", userId),
	},
	{
		name: "generationEvents",
		owner: "conversationId (denormalised; carries no owner field of its own)",
		mergeRule: "follows-conversation",
		eraseRule: "by-conversation",
		merge: async () => 0,
		erase: (_userId, ctx) => eraseByConversation(collections.generationEvents, ctx),
	},
	{
		name: "turnStates",
		owner: "userId, and conversationId+messageId",
		mergeRule: "reassign",
		eraseRule: "by-owner-or-conversation",
		ownerField: "userId",
		merge: (stray, target) => reassignSimple(collections.turnStates, "userId", stray, target),
		erase: (userId, ctx) =>
			eraseByOwnerOrConversation(collections.turnStates, "userId", userId, ctx),
	},
	{
		name: "codeRunFiles",
		owner: "conversationId (carries no owner field of its own)",
		mergeRule: "follows-conversation",
		eraseRule: "by-conversation",
		// The records naming a run's files; the bytes are `codeExecutionOutputs`,
		// erased by owner above. Conversation deletion already removes these
		// (`deleteConversationDeliverables`); this is account erasure's half.
		merge: async () => 0,
		erase: (_userId, ctx) => eraseByConversation(collections.codeRunFiles, ctx),
	},
	{
		name: "mcpElicitations",
		owner: "conversationId (carries no owner field of its own)",
		mergeRule: "follows-conversation",
		eraseRule: "by-conversation",
		merge: async () => 0,
		erase: (_userId, ctx) => eraseByConversation(collections.mcpElicitations, ctx),
	},
	{
		name: "parkedCalls",
		owner: "userId, and conversationId",
		mergeRule: "reassign",
		eraseRule: "by-owner-or-conversation",
		ownerField: "userId",
		// Reassigned like `generations`/`turnStates`: the sweeper that resumes
		// a parked tool call rebuilds the caller's identity from this row.
		merge: (stray, target) => reassignSimple(collections.parkedCalls, "userId", stray, target),
		erase: (userId, ctx) =>
			eraseByOwnerOrConversation(collections.parkedCalls, "userId", userId, ctx),
	},
	{
		name: "nestedAgentCalls",
		owner: "conversationId (carries no owner field of its own)",
		mergeRule: "follows-conversation",
		eraseRule: "by-conversation",
		merge: async () => 0,
		erase: (_userId, ctx) => eraseByConversation(collections.nestedAgentCalls, ctx),
	},
	{
		name: "abortedGenerations",
		owner: "conversationId (carries no owner field of its own)",
		mergeRule: "follows-conversation",
		eraseRule: "by-conversation",
		merge: async () => 0,
		erase: (_userId, ctx) => eraseByConversation(collections.abortedGenerations, ctx),
	},
	{
		name: "messageEvents",
		owner: "userId (sometimes a sessionId string, never a stray's conversation)",
		mergeRule: "delete-stray",
		eraseRule: "by-owner",
		ownerField: "userId",
		// Rate-limit bookkeeping, not content: the stray's are dropped rather
		// than reassigned, same as sessions.
		merge: (stray) => deleteStrayRows(collections.messageEvents, "userId", stray),
		erase: (userId) => eraseByField(collections.messageEvents, "userId", userId),
	},
	{
		name: "mcpOauthPending",
		owner: "userId",
		mergeRule: "delete-stray",
		eraseRule: "by-owner",
		ownerField: "userId",
		// An in-flight OAuth handshake started as the stray; carrying it over
		// to the target would hand the target's browser someone else's
		// callback state.
		merge: (stray) => deleteStrayRows(collections.mcpOauthPending, "userId", stray),
		erase: (userId) => eraseByField(collections.mcpOauthPending, "userId", userId),
	},
];

/** Every plain (non-`bucket:`) collection this registry names is declared in
 * `database.ts`'s `getCollections()` under this exact key — asserted by the
 * guard spec, not just assumed here. */
function collectionForCount(name: string): Pick<Collection<Document>, "countDocuments"> {
	return (collections as unknown as Record<string, Collection<Document>>)[name];
}

/**
 * A non-destructive count per registry entry, for the erasure preview (§9.3's
 * "dry run"): derived generically from `eraseRule`/`ownerField` for every
 * entry except the four `custom` ones, which carry their own `count`.
 */
export async function previewErasureCounts(
	userId: ObjectId,
	ctx: EraseContext
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const entry of USER_KEYED_COLLECTIONS) {
		if (entry.count) {
			counts[entry.name] = await entry.count(userId, ctx);
			continue;
		}
		const collection = collectionForCount(entry.name);
		switch (entry.eraseRule) {
			case "by-owner":
				counts[entry.name] = await collection.countDocuments({
					[entry.ownerField as string]: userId,
				} as never);
				break;
			case "by-conversation":
				counts[entry.name] =
					ctx.conversationIds.length === 0
						? 0
						: await collection.countDocuments({
								conversationId: { $in: ctx.conversationIds },
							} as never);
				break;
			case "by-owner-or-conversation": {
				const or: Record<string, unknown>[] = [{ [entry.ownerField as string]: userId }];
				if (ctx.conversationIds.length > 0) {
					or.push({ conversationId: { $in: ctx.conversationIds } });
				}
				counts[entry.name] = await collection.countDocuments({ $or: or } as never);
				break;
			}
			case "custom":
				// Every `custom` entry must carry its own `count` (checked above);
				// reaching here is a registry bug, not a runtime case to handle.
				throw new Error(`${entry.name}: eraseRule "custom" with no count()`);
		}
	}
	return counts;
}
