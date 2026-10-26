import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { onExit } from "$lib/server/exitHandler";
import { config } from "$lib/server/config";
import { MAX_FILE_BYTES } from "$lib/utils/execution/protocol";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import type { Conversation } from "$lib/types/Conversation";
import type { User } from "$lib/types/User";
import {
	previewInBackground,
	previewOwner,
	releasePreviewOwnerStrings,
	wantsEagerPreview,
} from "$lib/server/office/previewStore";

/**
 * Server-side, per-user persistence for `execute_code` deliverables (ADR
 * 0073's 2026-09-16 amendment): the browser's ExecutionSession already reads
 * a run's output files back as transferable bytes for the FileCard
 * (`readFile` in pyodide.worker.ts / `collectOutputFiles` in runs.svelte.ts);
 * `CodeExecutionCard` uploads exactly those bytes here once a run settles.
 *
 * **Deliverable rule: every produced file.** Every file a run's own
 * ExecutionSession lists as output (`RunState.outputFiles`) is a deliverable
 * and gets uploaded, whichever path ran it — an `execute_code` tool run, an
 * auto-running or manually run chat code block, an artifact cell. (It was
 * tool runs only until 2026-09-26, when the user widened it: "the point is
 * not how the file is created, the point is visualization" — one retention
 * rule and one way of showing a file, however it came to exist.) A tool run's
 * refs ride on its resolved update; the others are attached to their message
 * through `codeRunFiles`.
 *
 * Storage mirrors the message-attachment output store (`files/uploadFile.ts`,
 * `files/downloadFile.ts`): a dedicated GridFS bucket, content-addressed by
 * sha256 within a conversation so re-running identical output never
 * duplicates bytes, and downloads are access-controlled exactly like an
 * attachment (`authCondition`, checked by the routes that call
 * `downloadDeliverable`).
 */

/** Same ceiling the runtime itself enforces on a single file (protocol.ts). */
export const MAX_DELIVERABLE_BYTES = MAX_FILE_BYTES;

/**
 * A generous but bounded ceiling on how many distinct deliverables one
 * conversation can accumulate. Past this, a runaway loop that keeps
 * generating "new" files would otherwise grow the metadata collection
 * without limit; 200 matches the runtime's own per-listing cap
 * (MAX_LISTED_FILES) — a conversation cannot ask for more distinct files in
 * one run than that anyway.
 */
export const MAX_DELIVERABLES_PER_CONVERSATION = 200;

/**
 * Total stored bytes one conversation's deliverables may occupy. Five times
 * the single-file cap: enough headroom for a handful of real documents
 * without letting one chatty conversation's throwaway retries fill the
 * store — a per-deployment problem the retention period alone does not bound
 * quickly enough.
 */
export const MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION = 5 * MAX_DELIVERABLE_BYTES;

/** ADR 0073's amendment: computed deliverables persist for 30 days by default. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Ten years: a number past this is a typo, and "forever" is 0. */
export const MAX_RETENTION_DAYS = 3650;

/**
 * How many days produced files are kept: `CHAT_FILE_RETENTION_DAYS`, set from
 * Administration → Storage (or the environment), 0 for no expiry. Anything
 * that is not a whole number in range reads as the default rather than as
 * "forever" or "now": an unreadable value must not delete everything, nor
 * silently stop expiring.
 */
export function fileRetentionDays(): number {
	return parseRetentionDays(config.CHAT_FILE_RETENTION_DAYS);
}

/** `fileRetentionDays`'s reading of a raw value, on its own for the tests. */
export function parseRetentionDays(value: string | undefined): number {
	const raw = (value ?? "").trim();
	if (raw === "") return DEFAULT_RETENTION_DAYS;
	if (!/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;
	const days = Number(raw);
	return days <= MAX_RETENTION_DAYS ? days : DEFAULT_RETENTION_DAYS;
}

/** The instant before which a produced file has expired, or null when files never expire. */
export function retentionCutoff(days = fileRetentionDays(), now = Date.now()): Date | null {
	return days === 0 ? null : new Date(now - days * 24 * 60 * 60 * 1000);
}

export type StoreDeliverableResult =
	{ ok: true; ref: PersistedDeliverableRef } | { ok: false; status: 413; error: string };

/**
 * Store one deliverable's bytes for a conversation, deduped by content.
 *
 * The sha256 is computed here, over the raw bytes — never trusted from the
 * client — so two callers naming the same file differently, or the same
 * model retry producing byte-identical output, share one GridFS entry.
 */
export async function storeDeliverable({
	conversationId,
	userId,
	name,
	mime,
	bytes,
	derivedFrom,
}: {
	conversationId: Conversation["_id"];
	userId?: User["_id"];
	name: string;
	mime: string;
	bytes: Buffer;
	/** The stored file this one was made from (a document edit): recorded on its row. */
	derivedFrom?: { sha256: string; name: string };
}): Promise<StoreDeliverableResult> {
	if (bytes.byteLength > MAX_DELIVERABLE_BYTES) {
		return {
			ok: false,
			status: 413,
			error: `${name} is larger than the ${Math.floor(MAX_DELIVERABLE_BYTES / (1024 * 1024))}MB deliverable limit.`,
		};
	}

	const sha256 = createHash("sha256").update(bytes).digest("hex");

	const existing = await collections.codeExecutionOutputs.findOne({ conversationId, sha256 });
	if (existing) {
		return { ok: true, ref: { name: existing.name, size: existing.size, sha256 } };
	}

	const usage = await collections.codeExecutionOutputs
		.aggregate<{ count: number; totalBytes: number }>([
			{ $match: { conversationId } },
			{ $group: { _id: null, count: { $sum: 1 }, totalBytes: { $sum: "$size" } } },
		])
		.next();
	const count = usage?.count ?? 0;
	const totalBytes = usage?.totalBytes ?? 0;

	if (count >= MAX_DELIVERABLES_PER_CONVERSATION) {
		return {
			ok: false,
			status: 413,
			error: "This conversation has reached its limit of persisted deliverable files.",
		};
	}
	if (totalBytes + bytes.byteLength > MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION) {
		return {
			ok: false,
			status: 413,
			error: "This conversation has reached its stored deliverable size limit.",
		};
	}

	const gridFsId = new ObjectId();
	const upload = collections.codeOutputBucket.openUploadStreamWithId(
		gridFsId,
		`${conversationId.toString()}-${sha256}`,
		{ metadata: { conversation: conversationId.toString(), mime } }
	);
	upload.write(bytes);
	upload.end();
	await new Promise<void>((resolve, reject) => {
		upload.once("finish", () => resolve());
		upload.once("error", reject);
		setTimeout(() => reject(new Error("Deliverable upload timed out")), 20_000);
	});

	await collections.codeExecutionOutputs.insertOne({
		_id: new ObjectId(),
		conversationId,
		...(userId ? { userId } : {}),
		sha256,
		name,
		mime,
		size: bytes.byteLength,
		gridFsId,
		...(derivedFrom
			? { derivedFromSha256: derivedFrom.sha256, derivedFromName: derivedFrom.name }
			: {}),
		createdAt: new Date(),
	});

	// A produced Office file is opened at once, so its PDF preview is made now
	// (when the deployment has a converter) instead of at the first click.
	if (wantsEagerPreview(name, bytes.byteLength)) {
		previewInBackground({
			bytes,
			name,
			owner: previewOwner("out", conversationId.toString(), sha256),
		});
	}

	return { ok: true, ref: { name, size: bytes.byteLength, sha256 } };
}

/** Read one deliverable's bytes back. The caller is responsible for the access check. */
export async function downloadDeliverable(
	conversationId: Conversation["_id"],
	sha256: string
): Promise<{ buffer: Buffer; name: string; mime: string } | undefined> {
	const meta = await collections.codeExecutionOutputs.findOne({ conversationId, sha256 });
	if (!meta) return undefined;

	const stream = collections.codeOutputBucket.openDownloadStream(meta.gridFsId);
	const buffer = await new Promise<Buffer>((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(Buffer.concat(chunks)));
	});

	return { buffer, name: meta.name, mime: meta.mime };
}

async function deleteRows(
	rows: Array<{ _id: ObjectId; gridFsId: ObjectId; conversationId?: ObjectId; sha256?: string }>
): Promise<void> {
	if (rows.length === 0) return;
	await Promise.all(
		rows.map((row) =>
			collections.codeOutputBucket
				.delete(row.gridFsId)
				.catch((err) =>
					logger.error(
						{ err, id: row._id.toString() },
						"[code-execution] failed to delete deliverable bytes"
					)
				)
		)
	);
	await collections.codeExecutionOutputs.deleteMany({ _id: { $in: rows.map((row) => row._id) } });
	// Their Office previews are derived from them (`office/previewStore.ts`).
	await releasePreviewOwnerStrings(
		rows.flatMap((row) =>
			row.conversationId && row.sha256
				? [previewOwner("out", row.conversationId.toString(), row.sha256)]
				: []
		)
	).catch((err) => logger.error({ err }, "[code-execution] failed to release office previews"));
}

/**
 * Delete every deliverable a conversation (or set of conversations) has
 * persisted. Bytes and metadata go together — `bucket.delete()` removes both
 * the GridFS file and its chunks, so nothing is left orphaned the way a bare
 * `deleteMany` on the metadata collection alone would leave the bytes.
 */
export async function deleteConversationDeliverables(
	conversationId: Conversation["_id"] | Conversation["_id"][]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;
	const rows = await collections.codeExecutionOutputs
		.find({ conversationId: { $in: ids } })
		.project<{ _id: ObjectId; gridFsId: ObjectId; conversationId: ObjectId; sha256: string }>({
			gridFsId: 1,
			conversationId: 1,
			sha256: 1,
		})
		.toArray();
	await deleteRows(rows);
	// The records naming which message those files belonged to go with them.
	await collections.codeRunFiles.deleteMany({ conversationId: { $in: ids } });
}

const SWEEP_BATCH = 200;
/** A stored file younger than this may still be waiting for its metadata row
 * (`storeDeliverable` uploads the bytes first), so it is never an orphan. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * The retention cleanup: bytes, metadata and the message records naming them,
 * together. This sweep is the only thing that expires a produced file. It
 * used to share the job with a native 30-day TTL index on the metadata, and
 * the two raced: the TTL monitor (every minute) deleted a row as soon as it
 * turned 30 days old, while this sweep (hourly) finds files *through* those
 * rows, so it usually found nothing and the GridFS bytes stayed for ever.
 * The TTL indexes are gone (database.ts); `sweepOrphanedDeliverableBytes`
 * frees what they left behind.
 */
export async function sweepExpiredDeliverables(
	now = Date.now(),
	days = fileRetentionDays()
): Promise<number> {
	const cutoff = retentionCutoff(days, now);
	if (!cutoff) return 0;
	let removed = 0;
	for (;;) {
		const stale = await collections.codeExecutionOutputs
			.find({ createdAt: { $lt: cutoff } })
			.project<{ _id: ObjectId; gridFsId: ObjectId; conversationId: ObjectId; sha256: string }>({
				gridFsId: 1,
				conversationId: 1,
				sha256: 1,
			})
			.limit(SWEEP_BATCH)
			.toArray();
		if (stale.length === 0) break;
		await deleteRows(stale);
		removed += stale.length;
		if (stale.length < SWEEP_BATCH) break;
	}
	await collections.codeRunFiles.deleteMany({ createdAt: { $lt: cutoff } });
	if (removed > 0) logger.info({ count: removed }, "[code-execution] swept expired deliverables");
	return removed;
}

/**
 * GridFS files in the deliverables bucket that no metadata row names: what
 * the old TTL index left behind (see `sweepExpiredDeliverables`), or a
 * crash between the upload and the row's insert. Nothing can ever read
 * them — downloads go through the row — so they are deleted, bytes and
 * chunks, once past a grace period that covers an upload in flight.
 */
export async function sweepOrphanedDeliverableBytes(now = Date.now()): Promise<number> {
	const before = new Date(now - ORPHAN_GRACE_MS);
	let removed = 0;
	let after: ObjectId | null = null;
	for (;;) {
		const page: Array<{ _id: ObjectId }> = await collections.codeOutputBucket
			.find(
				after
					? { uploadDate: { $lt: before }, _id: { $gt: after } }
					: { uploadDate: { $lt: before } }
			)
			.project<{ _id: ObjectId }>({ _id: 1 })
			.sort({ _id: 1 })
			.limit(SWEEP_BATCH)
			.toArray();
		if (page.length === 0) break;
		after = page[page.length - 1]._id;
		const named = new Set(
			(
				await collections.codeExecutionOutputs
					.find({ gridFsId: { $in: page.map((o) => o._id) } })
					.project<{ gridFsId: ObjectId }>({ gridFsId: 1 })
					.toArray()
			).map((row) => row.gridFsId.toString())
		);
		for (const file of page) {
			if (named.has(file._id.toString())) continue;
			await collections.codeOutputBucket
				.delete(file._id)
				.then(() => {
					removed += 1;
				})
				.catch((err) =>
					logger.error(
						{ err, id: file._id.toString() },
						"[code-execution] failed to delete orphaned deliverable bytes"
					)
				);
		}
		if (page.length < SWEEP_BATCH) break;
	}
	if (removed > 0) {
		logger.info({ count: removed }, "[code-execution] freed orphaned deliverable bytes");
	}
	return removed;
}

/** What Administration → Storage shows: the store's size, and how much of it a
 * given retention would remove at the next sweep. */
export async function deliverableStorageSummary(days: number, now = Date.now()) {
	const totals = await collections.codeExecutionOutputs
		.aggregate<{ count: number; bytes: number }>([
			{ $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$size" } } },
		])
		.next();
	const cutoff = retentionCutoff(days, now);
	const expiring = cutoff
		? await collections.codeExecutionOutputs
				.aggregate<{ count: number; bytes: number }>([
					{ $match: { createdAt: { $lt: cutoff } } },
					{ $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$size" } } },
				])
				.next()
		: null;
	return {
		files: totals?.count ?? 0,
		bytes: totals?.bytes ?? 0,
		expiring: { files: expiring?.count ?? 0, bytes: expiring?.bytes ?? 0 },
	};
}

function sweepIntervalMs(): number {
	const raw = config.DELIVERABLE_SWEEP_INTERVAL_MS;
	const parsed = raw ? parseInt(raw, 10) : NaN;
	return !isNaN(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000;
}

export class DeliverableReaper {
	private static instance: DeliverableReaper;

	private constructor() {
		const sweep = () =>
			sweepExpiredDeliverables()
				.then(() => sweepOrphanedDeliverableBytes())
				.catch((err) => logger.error({ err }, "[code-execution] deliverable sweep failed"));
		const interval = setInterval(sweep, sweepIntervalMs());
		interval.unref?.();
		onExit(() => clearInterval(interval));

		sweep();
	}

	public static getInstance(): DeliverableReaper {
		if (!DeliverableReaper.instance) {
			DeliverableReaper.instance = new DeliverableReaper();
		}
		return DeliverableReaper.instance;
	}
}

/**
 * Mark which of a client's file references are really in this conversation's
 * store. The client says what its run produced (name, size, sha256 it
 * computed) whether or not its upload succeeded; nothing about "uploaded" is
 * taken on its word. A reference whose bytes are stored keeps `uploaded: true`,
 * every other one is recorded `uploaded: false` — produced, but only
 * downloadable from the tab that made it, which its card says. Names and
 * sizes stay the client's own: the store dedupes by content and would
 * otherwise hand back whichever name stored those bytes first.
 */
export async function markStoredRefs(
	conversationId: Conversation["_id"],
	refs: Array<{ name: string; size: number; sha256: string }>
): Promise<PersistedDeliverableRef[]> {
	if (refs.length === 0) return [];
	const rows = await collections.codeExecutionOutputs
		.find({ conversationId, sha256: { $in: [...new Set(refs.map((r) => r.sha256))] } })
		.project<{ sha256: string }>({ sha256: 1 })
		.toArray();
	const stored = new Set(rows.map((row) => row.sha256));
	return refs.map((ref) => ({
		name: ref.name,
		size: ref.size,
		sha256: ref.sha256,
		uploaded: stored.has(ref.sha256),
	}));
}
