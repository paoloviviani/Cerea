import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { withRunFiles } from "$lib/server/execution/runFiles";
import { previewOwner, releasePreviewOwnerStrings } from "$lib/server/office/previewStore";
import { shareStatus } from "$lib/server/sharing/shares";
import { collectArtifacts } from "$lib/utils/artifacts";
import { collectFileArtifacts, fileVersionKey } from "$lib/utils/fileArtifacts";
import type { Message } from "$lib/types/Message";
import type { SharedArtifact } from "$lib/types/SharedArtifact";
import { maxArtifactVersions } from "./settings";

/**
 * Pruning old artifact versions (C122).
 *
 * Versions are derived from the conversation's messages, so a text version is not a row
 * that can be removed: the message tree stays as it was, and a deleted version is recorded
 * on the conversation (`prunedArtifactVersions`) and shown as deleted. A file version is a
 * `codeExecutionOutputs` row with bytes: those are freed, through `BlobStore`, unless
 * another version or row still needs them.
 *
 * Two rules hold everywhere:
 * - the newest `keep` live versions of an artifact on a branch of the conversation stay
 *   (a manual "Delete older versions" keeps 1: the current one);
 * - a version with an active share link (not revoked, not expired, whatever the audience
 *   and whether or not sharing is switched on right now) is never deleted.
 *
 * Idempotent: a deleted version is skipped, a row already gone is not an error. Logs and
 * audits carry counts only, never content.
 */

export interface PruneResult {
	/** Versions deleted by this call. */
	deleted: number;
	/** Older versions kept because an active share link points at them. */
	keptShared: number;
	/** Stored files whose bytes were freed. */
	freedFiles: number;
}

export class PruneError extends Error {
	constructor(
		readonly status: 404,
		message: string
	) {
		super(message);
	}
}

export interface PruneOptions {
	/** How many of the newest versions of each artifact stay (at least 1). */
	keep: number;
	/** Only this text artifact (by identifier) or file (by name). */
	identifier?: string;
	/** The message at the end of the branch the user is looking at; absent: every branch. */
	leafMessageId?: string;
}

type PathMessage = Pick<Message, "id" | "from" | "content" | "updates" | "ancestors" | "children">;

const MAX_LEAVES = 200;

/** Every branch of the conversation tree as the list of messages from the root to a leaf. */
function branches(messages: PathMessage[]): PathMessage[][] {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const treed = messages.some((m) => m.ancestors !== undefined);
	if (!treed) return [messages];
	return messages
		.filter((m) => !m.children || m.children.length === 0)
		.slice(0, MAX_LEAVES)
		.map((leaf) =>
			[...(leaf.ancestors ?? []), leaf.id].flatMap((id) => {
				const message = byId.get(id);
				return message ? [message] : [];
			})
		);
}

async function activeShares(conversationId: ObjectId, now: Date): Promise<SharedArtifact[]> {
	const rows = await collections.sharedArtifacts
		.find({ conversationId, revokedAt: null })
		.toArray();
	return rows.filter((row) => shareStatus(row, now) === "active");
}

/**
 * Free stored files: bytes through `BlobStore` unless another row still names the same blob,
 * then the rows, then the previews derived from them. Bytes first, so a crash leaves rows for
 * the next run to finish.
 */
async function freeRows(
	rows: Array<{ _id: ObjectId; gridFsId: ObjectId; conversationId: ObjectId; sha256: string }>
): Promise<number> {
	if (rows.length === 0) return 0;
	const going = rows.map((row) => row._id);
	const blobs = [...new Map(rows.map((row) => [row.gridFsId.toString(), row.gridFsId])).values()];
	const shared = new Set(
		(
			await collections.codeExecutionOutputs
				.find({ gridFsId: { $in: blobs }, _id: { $nin: going } })
				.project<{ gridFsId: ObjectId }>({ gridFsId: 1 })
				.toArray()
		).map((row) => row.gridFsId.toString())
	);
	const free = blobs.filter((id) => !shared.has(id.toString()));
	if (free.length > 0) {
		const { failed } = await collections.blobStore.deleteMany("codeOutputs", free);
		for (const { id, error } of failed) {
			logger.error({ err: error, id: id.toString() }, "[artifact-versions] failed to free bytes");
		}
		if (failed.length > 0) {
			// Keep the rows whose bytes are still there: the next run retries them.
			const stuck = new Set(failed.map((f) => f.id.toString()));
			rows = rows.filter((row) => !stuck.has(row.gridFsId.toString()));
		}
	}
	await collections.codeExecutionOutputs.deleteMany({ _id: { $in: rows.map((row) => row._id) } });
	await releasePreviewOwnerStrings(
		rows.map((row) => previewOwner("out", row.conversationId.toString(), row.sha256))
	).catch((err) => logger.error({ err }, "[artifact-versions] failed to release office previews"));
	return rows.length;
}

/** Delete the versions of one conversation that `options` says may go. */
export async function pruneConversation(
	conversationId: ObjectId,
	options: PruneOptions,
	now = new Date()
): Promise<PruneResult & { pruned: string[] }> {
	const keep = Math.max(1, Math.floor(options.keep));
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{
			projection: {
				"messages.id": 1,
				"messages.from": 1,
				"messages.content": 1,
				"messages.updates": 1,
				"messages.ancestors": 1,
				"messages.children": 1,
				prunedArtifactVersions: 1,
			},
		}
	);
	if (!conversation) throw new PruneError(404, "No such conversation.");
	const messages = (await withRunFiles(conversationId, conversation.messages)) as PathMessage[];
	const pruned = new Set(conversation.prunedArtifactVersions ?? []);
	const shares = await activeShares(conversationId, now);
	const everyBranch = branches(messages);
	if (options.leafMessageId && !messages.some((m) => m.id === options.leafMessageId)) {
		throw new PruneError(404, "No such message.");
	}
	// With a message (the one that made the version on screen), only branches through it are
	// pruned, and only where it is the artifact's newest version.
	const isTargeted = (branch: PathMessage[]) =>
		!options.leafMessageId || branch.some((m) => m.id === options.leafMessageId);
	const newestIsOnScreen = (messageId: string | undefined) =>
		!options.leafMessageId || messageId === options.leafMessageId;

	const wanted = (id: string) => options.identifier === undefined || options.identifier === id;
	/** key -> why it is spared. */
	const keepers = new Set<string>();
	const candidates = new Map<
		string,
		{ shared: boolean; file?: { name: string; sha256: string } }
	>();
	/** (name, sha256) of every file version that stays, to know which rows are still needed. */
	const stillUsed = new Set<string>();

	for (const branch of everyBranch) {
		const targeted = isTargeted(branch);
		const text = collectArtifacts(branch, undefined, pruned);
		for (const artifact of text.artifacts.values()) {
			const live = artifact.versions.filter((v) => !v.deleted && v.opKey);
			for (const v of live.slice(-keep)) keepers.add(v.opKey as string);
			if (!targeted || !wanted(artifact.identifier) || !newestIsOnScreen(live.at(-1)?.messageId))
				continue;
			for (const v of live.slice(0, Math.max(0, live.length - keep))) {
				const shared = shares.some(
					(s) =>
						s.snapshot.kind === "text" &&
						s.artifactId === artifact.identifier &&
						s.snapshot.content === v.content
				);
				candidates.set(v.opKey as string, { shared });
			}
		}
		const files = collectFileArtifacts(branch, pruned);
		for (const artifact of files.artifacts.values()) {
			const live = artifact.versions.filter((v) => !v.deleted);
			const key = (v: (typeof live)[number]) => fileVersionKey(v.messageId, v.name, v.sha256);
			for (const v of live.slice(-keep)) {
				keepers.add(key(v));
				stillUsed.add(`${v.name}\u0000${v.sha256}`);
			}
			if (!targeted || !wanted(artifact.name) || !newestIsOnScreen(live.at(-1)?.messageId))
				continue;
			for (const v of live.slice(0, Math.max(0, live.length - keep))) {
				const shared = shares.some(
					(s) =>
						s.snapshot.kind === "file" &&
						s.snapshot.name === v.name &&
						s.snapshot.sha256 === v.sha256
				);
				candidates.set(key(v), { shared, file: { name: v.name, sha256: v.sha256 } });
			}
		}
	}

	const marked: string[] = [];
	let keptShared = 0;
	const freeing = new Map<string, { name: string; sha256: string }>();
	for (const [key, candidate] of candidates) {
		if (keepers.has(key)) continue;
		if (candidate.shared) {
			keptShared += 1;
			if (candidate.file) stillUsed.add(`${candidate.file.name}\u0000${candidate.file.sha256}`);
			continue;
		}
		marked.push(key);
		if (candidate.file)
			freeing.set(`${candidate.file.name}\u0000${candidate.file.sha256}`, candidate.file);
	}
	// A candidate that shares its content with a version that stays (a file made again
	// later with the same bytes) is marked deleted but its stored file stays.
	// Shared-file candidates were added to stillUsed above, after the loop saw them first;
	// recheck so ordering does not matter.
	for (const key of [...freeing.keys()]) if (stillUsed.has(key)) freeing.delete(key);

	let freedFiles = 0;
	if (freeing.size > 0) {
		const rows = await collections.codeExecutionOutputs
			.find({
				conversationId,
				$or: [...freeing.values()].map((f) => ({ name: f.name, sha256: f.sha256 })),
			})
			.project<{ _id: ObjectId; gridFsId: ObjectId; conversationId: ObjectId; sha256: string }>({
				gridFsId: 1,
				conversationId: 1,
				sha256: 1,
			})
			.toArray();
		freedFiles = await freeRows(rows);
	}
	if (marked.length > 0) {
		await collections.conversations.updateOne(
			{ _id: conversationId },
			{ $addToSet: { prunedArtifactVersions: { $each: marked } } }
		);
	}
	return { deleted: marked.length, keptShared, freedFiles, pruned: [...pruned, ...marked] };
}

/** One user's "Delete older versions" on one artifact: keeps the current version on that branch. */
export async function deleteOlderVersions(
	owner: { userId?: ObjectId; sessionId?: string },
	input: { conversationId: ObjectId; identifier: string; leafMessageId?: string }
): Promise<PruneResult & { pruned: string[] }> {
	const filter = owner.userId
		? { _id: input.conversationId, userId: owner.userId }
		: { _id: input.conversationId, sessionId: owner.sessionId, userId: { $exists: false } };
	const own = await collections.conversations.findOne(filter, { projection: { _id: 1 } });
	if (!own) throw new PruneError(404, "No such artifact.");
	const result = await pruneConversation(input.conversationId, {
		keep: 1,
		identifier: input.identifier,
		leafMessageId: input.leafMessageId,
	});
	logger.info(
		{
			audit: "artifact_versions",
			conversation: input.conversationId.toString(),
			user: owner.userId?.toString(),
			deleted: result.deleted,
			keptShared: result.keptShared,
			freedFiles: result.freedFiles,
		},
		"artifact_versions_deleted"
	);
	return result;
}

const FULL_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let lastFullSweep = 0;

/** The next sweep scans every conversation (the limit was changed: older chats may now be over it). */
export function requestFullVersionSweep(): void {
	lastFullSweep = 0;
}

/**
 * The deployment's "keep at most N versions per artifact" (`ARTIFACT_MAX_VERSIONS` or the
 * administrator's value). Called from the deliverable sweep. File artifacts are found
 * cheaply (stored rows grouped by name); text artifacts need the messages read, so they are
 * looked for in conversations changed since the last pass, plus a full pass the first time,
 * once a day and after the limit changes. Returns how many versions were deleted.
 */
export async function sweepArtifactVersions(now = new Date(), full?: boolean): Promise<number> {
	const keep = await maxArtifactVersions();
	if (keep === 0) return 0;
	const doFull = full ?? now.getTime() - lastFullSweep > FULL_SWEEP_EVERY_MS;
	const since = new Date(lastFullSweep ? now.getTime() - 2 * 60 * 60 * 1000 : 0);
	if (doFull) lastFullSweep = now.getTime();

	const ids = new Map<string, ObjectId>();
	const overFiles = await collections.codeExecutionOutputs
		.aggregate<{ _id: { conversationId: ObjectId } }>([
			{ $group: { _id: { conversationId: "$conversationId", name: "$name" }, n: { $sum: 1 } } },
			{ $match: { n: { $gt: keep } } },
		])
		.toArray();
	for (const row of overFiles) ids.set(row._id.conversationId.toString(), row._id.conversationId);
	const textFilter = {
		messages: { $elemMatch: { from: "assistant", content: { $regex: "<artifact" } } },
		...(doFull ? {} : { updatedAt: { $gte: since } }),
	};
	const withText = collections.conversations
		.find(textFilter)
		.project<{ _id: ObjectId }>({ _id: 1 });
	for await (const row of withText) ids.set(row._id.toString(), row._id);

	let deleted = 0;
	let freedFiles = 0;
	let keptShared = 0;
	for (const id of ids.values()) {
		try {
			const result = await pruneConversation(id, { keep }, now);
			deleted += result.deleted;
			freedFiles += result.freedFiles;
			keptShared += result.keptShared;
		} catch (err) {
			logger.error({ err, conversation: id.toString() }, "[artifact-versions] prune failed");
		}
	}
	if (deleted > 0 || freedFiles > 0) {
		logger.info(
			{ audit: "artifact_versions", keep, deleted, keptShared, freedFiles, full: doFull },
			"artifact_versions_swept"
		);
	}
	return deleted;
}
