/**
 * Files in the chat bucket whose owner is gone: the sweep that finds what
 * `deleteConversationStorage` could not, or what a release before it left.
 *
 * Every attachment, extracted text, code deliverable and shared copy is tagged
 * `metadata.conversation` with one of three kinds of owner key, and this
 * checks the owner from the side that still exists:
 *
 * - a **conversation id** (24 hex) with no conversation;
 * - a **share id** (the nanoid of `sharedConversations`) with no share — and
 *   the shares themselves whose `conversationId` names a conversation that is
 *   gone, with their copies;
 * - a **`code:<device>:<session>`** key whose device row is gone. Sessions
 *   live on the machine, not here, so a session cannot be told dead from this
 *   side; only the device can, which is what `deleteCodeDeviceAttachments`
 *   does at revoke and this backstops.
 *
 * - a **`project:<id>`** key (a project's context documents) whose project
 *   is gone. Deleting the project removes them; this backstops a delete that
 *   died halfway.
 *
 * Anything else is left alone: a tag that is none of these is somebody
 * else's, and a wrong guess deletes it.
 *
 * Only files older than the grace period are touched. An upload to a
 * conversation that has just been made, or a share copy being written while
 * its row is already there, must not be swept out from under the request
 * that is making it.
 */
import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { parseCodeAttachmentKey } from "$lib/server/codeAttachments";
import { parseProjectOwnerKey } from "$lib/server/projectDocuments";
import { deleteConversationAttachments } from "./deleteConversationAttachments";

export const ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

export interface OrphanAttachmentCounts {
	files: number;
	shares: number;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;
/** `nanoid(7)`, the share id alphabet. */
const SHARE_ID = /^[A-Za-z0-9_-]{7}$/;

function batches<T>(items: T[], size = BATCH): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Which of these owner tags have no owner. */
async function deadTags(tags: string[]): Promise<string[]> {
	const objectIds = tags.filter((tag) => OBJECT_ID.test(tag));
	const shareIds = tags.filter((tag) => !OBJECT_ID.test(tag) && SHARE_ID.test(tag));
	const codeKeys = tags
		.map((tag) => ({ tag, parts: parseCodeAttachmentKey(tag) }))
		.filter((entry) => entry.parts);

	const dead: string[] = [];

	const liveConversations = new Set(
		(
			await collections.conversations
				.find({ _id: { $in: objectIds.map((id) => new ObjectId(id)) } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
		).map((row) => row._id.toString())
	);
	dead.push(...objectIds.filter((id) => !liveConversations.has(id)));

	const liveShares = new Set(
		(
			await collections.sharedConversations
				.find({ _id: { $in: shareIds } })
				.project<{ _id: string }>({ _id: 1 })
				.toArray()
		).map((row) => row._id)
	);
	dead.push(...shareIds.filter((id) => !liveShares.has(id)));

	const deviceIds = [...new Set(codeKeys.map((entry) => entry.parts?.deviceId ?? ""))];
	const liveDevices = new Set(
		(
			await collections.codeDevices
				.find({ _id: { $in: deviceIds.map((id) => new ObjectId(id)) } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
		).map((row) => row._id.toString())
	);
	dead.push(
		...codeKeys.filter((entry) => !liveDevices.has(entry.parts?.deviceId ?? "")).map((e) => e.tag)
	);

	const projectKeys = tags
		.map((tag) => ({ tag, id: parseProjectOwnerKey(tag) }))
		.filter((entry): entry is { tag: string; id: string } => entry.id !== null);
	const liveProjects = new Set(
		(
			await collections.projects
				.find({ _id: { $in: projectKeys.map((entry) => new ObjectId(entry.id)) } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
		).map((row) => row._id.toString())
	);
	dead.push(...projectKeys.filter((entry) => !liveProjects.has(entry.id)).map((e) => e.tag));
	return dead;
}

/** Shares whose source conversation is gone: the link and its copies go too. */
async function sweepOrphanShares(): Promise<number> {
	const linked = await collections.sharedConversations
		.find({ conversationId: { $exists: true } })
		.project<{ _id: string; conversationId: ObjectId }>({ _id: 1, conversationId: 1 })
		.toArray();
	let removed = 0;
	for (const batch of batches(linked)) {
		const live = new Set(
			(
				await collections.conversations
					.find({ _id: { $in: batch.map((share) => share.conversationId) } })
					.project<{ _id: ObjectId }>({ _id: 1 })
					.toArray()
			).map((row) => row._id.toString())
		);
		const gone = batch.filter((share) => !live.has(share.conversationId.toString()));
		if (gone.length === 0) continue;
		const ids = gone.map((share) => share._id);
		await collections.sharedConversations.deleteMany({ _id: { $in: ids } });
		await deleteConversationAttachments(ids);
		removed += ids.length;
	}
	return removed;
}

/** One pass. Throws only on a database failure; the caller logs and moves on. */
export async function sweepOrphanAttachments(now = new Date()): Promise<OrphanAttachmentCounts> {
	const counts: OrphanAttachmentCounts = { files: 0, shares: 0 };
	// Shares first, so the copies they leave are found as dead tags below at
	// the latest, and the ones they delete here are not counted twice.
	counts.shares = await sweepOrphanShares();

	const cutoff = new Date(now.getTime() - ATTACHMENT_GRACE_MS);
	const tags = (await collections.bucketFiles.distinct("metadata.conversation", {
		"metadata.conversation": { $type: "string" },
		uploadDate: { $lt: cutoff },
	})) as string[];

	for (const batch of batches(tags)) {
		for (const tag of await deadTags(batch)) {
			const files = await collections.bucketFiles
				.find({ "metadata.conversation": tag, uploadDate: { $lt: cutoff } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray();
			for (const file of files) {
				try {
					await collections.bucket.delete(file._id);
					counts.files++;
				} catch (err) {
					logger.warn(
						{ err, fileId: file._id.toString(), owner: tag },
						"orphan_attachment_delete_failed"
					);
				}
			}
		}
	}
	return counts;
}
