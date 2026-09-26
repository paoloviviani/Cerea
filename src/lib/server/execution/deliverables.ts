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
 * store — a per-deployment problem the 30-day TTL alone does not bound
 * quickly enough.
 */
export const MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION = 5 * MAX_DELIVERABLE_BYTES;

/** ADR 0073's amendment: computed deliverables persist for 30 days. */
export const DELIVERABLE_TTL_SECONDS = 30 * 24 * 60 * 60;

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
}: {
	conversationId: Conversation["_id"];
	userId?: User["_id"];
	name: string;
	mime: string;
	bytes: Buffer;
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
		createdAt: new Date(),
	});

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

async function deleteRows(rows: Array<{ _id: ObjectId; gridFsId: ObjectId }>): Promise<void> {
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
		.project<{ _id: ObjectId; gridFsId: ObjectId }>({ gridFsId: 1 })
		.toArray();
	await deleteRows(rows);
	// The records naming which message those files belonged to go with them.
	await collections.codeRunFiles.deleteMany({ conversationId: { $in: ids } });
}

const SWEEP_BATCH = 200;

/**
 * The actual 30-day cleanup. A native Mongo TTL index cannot do this by
 * itself for a GridFS-backed store (see the comment beside the index in
 * database.ts): deleting the metadata row does not cascade to the file's
 * chunks. This sweep is the one that frees the bytes, via the same
 * `bucket.delete()` path a conversation delete uses.
 */
export async function sweepExpiredDeliverables(): Promise<void> {
	const cutoff = new Date(Date.now() - DELIVERABLE_TTL_SECONDS * 1000);
	const stale = await collections.codeExecutionOutputs
		.find({ createdAt: { $lt: cutoff } })
		.project<{ _id: ObjectId; gridFsId: ObjectId }>({ gridFsId: 1 })
		.limit(SWEEP_BATCH)
		.toArray();
	if (stale.length === 0) return;
	logger.info({ count: stale.length }, "[code-execution] sweeping expired deliverables");
	await deleteRows(stale);
}

function sweepIntervalMs(): number {
	const raw = config.DELIVERABLE_SWEEP_INTERVAL_MS;
	const parsed = raw ? parseInt(raw, 10) : NaN;
	return !isNaN(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000;
}

export class DeliverableReaper {
	private static instance: DeliverableReaper;

	private constructor() {
		const interval = setInterval(() => {
			sweepExpiredDeliverables().catch((err) =>
				logger.error({ err }, "[code-execution] deliverable sweep failed")
			);
		}, sweepIntervalMs());
		interval.unref?.();
		onExit(() => clearInterval(interval));

		sweepExpiredDeliverables().catch((err) =>
			logger.error({ err }, "[code-execution] initial deliverable sweep failed")
		);
	}

	public static getInstance(): DeliverableReaper {
		if (!DeliverableReaper.instance) {
			DeliverableReaper.instance = new DeliverableReaper();
		}
		return DeliverableReaper.instance;
	}
}
