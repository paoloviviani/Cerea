/**
 * Previews of Office files, kept in the chat's own file store.
 *
 * A preview is the PDF Gotenberg made from a file's bytes. It is stored in the
 * same GridFS bucket as attachments and extracted text (`files/uploadFile.ts`),
 * named by what it was made from and how:
 *
 *     preview-<CONVERTER_VERSION>-<sha256 of the source bytes>
 *
 * - identical bytes (the same deck attached in two conversations, or an
 *   attachment and a deliverable) share one preview;
 * - an edited file has other bytes and gets its own;
 * - a new `CONVERTER_VERSION` names a different entry, so every old preview
 *   stops matching and is made again on its next view. The old ones are not
 *   read any more and go with their owners (below) or the sweep.
 *
 * **Who keeps a preview alive.** The entry carries `metadata.owners`: one
 * string per source file that has used it, `att:<conversation or share id>-<stored
 * sha>` for an attachment and `out:<conversation id>-<sha256>` for a produced
 * file — exactly the stored file's GridFS name, so "does the source still
 * exist" is a lookup. Reading or making a preview adds the caller's owner;
 * everything that deletes files removes owners (`releasePreviewOwners`) and
 * the entry is deleted when the last one goes. Two files that share a preview
 * therefore keep it until *both* are gone. `sweepOrphanPreviews` is the
 * backstop for the paths that delete a file without saying so (retention
 * expiry, a crash halfway): it drops owners whose source no longer exists.
 *
 * Previews carry no `metadata.conversation`, on purpose: that tag is how
 * `downloadFile`, the conversation delete and the orphan sweep find a
 * conversation's files, and a preview shared across conversations belongs to
 * none of them.
 *
 * Access is the caller's job: a route checks that the person may read the
 * *source* file, and only then asks for its preview.
 */

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	CONVERTER_VERSION,
	MAX_SOURCE_BYTES,
	convertOfficeToPdf,
	isGotenbergEnabled,
	isOfficeDocument,
} from "./gotenberg";

export type PreviewSourceKind = "att" | "out";

/** The owner string for one stored source file (see the header). */
export function previewOwner(kind: PreviewSourceKind, ownerTag: string, storedSha: string): string {
	return `${kind}:${ownerTag}-${storedSha}`;
}

export function sourceSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The GridFS name of the preview of these source bytes under this converter version. */
export function previewFilename(sha256: string, version = CONVERTER_VERSION): string {
	return `preview-${version}-${sha256}`;
}

interface PreviewRow {
	_id: ObjectId;
	filename: string;
	metadata?: { preview?: boolean; owners?: string[] };
}

async function findRows(filename: string): Promise<PreviewRow[]> {
	return (await collections.bucketFiles
		.find({ filename, "metadata.preview": true })
		.sort({ _id: 1 })
		.toArray()) as PreviewRow[];
}

async function readBytes(id: ObjectId): Promise<Buffer> {
	const stream = collections.bucket.openDownloadStream(id);
	const chunks: Uint8Array[] = [];
	return new Promise<Buffer>((resolve, reject) => {
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

async function writePreview(
	filename: string,
	pdf: Buffer,
	sha: string,
	owner: string
): Promise<ObjectId> {
	const id = new ObjectId();
	const upload = collections.bucket.openUploadStreamWithId(id, filename, {
		metadata: { preview: true, version: CONVERTER_VERSION, sha256: sha, owners: [owner] },
	});
	upload.write(pdf);
	upload.end();
	await new Promise<void>((resolve, reject) => {
		upload.once("finish", () => resolve());
		upload.once("error", reject);
		setTimeout(() => reject(new Error("Preview upload timed out")), 20_000);
	});
	return id;
}

/**
 * Two requests (or two servers) can make the same preview at once, and GridFS
 * has no unique name. Whoever notices keeps the oldest entry, folds the
 * others' owners into it and deletes them.
 */
async function collapseDuplicates(filename: string): Promise<void> {
	const rows = await findRows(filename);
	if (rows.length < 2) return;
	const [keep, ...extra] = rows;
	const owners = [...new Set(extra.flatMap((row) => row.metadata?.owners ?? []))];
	if (owners.length > 0) {
		await collections.bucketFiles.updateOne(
			{ _id: keep._id },
			{ $addToSet: { "metadata.owners": { $each: owners } } }
		);
	}
	await Promise.all(extra.map((row) => collections.bucket.delete(row._id).catch(() => undefined)));
}

const making = new Map<string, Promise<void>>();

export interface PreviewRequest {
	/** The source file's bytes, which the caller has already been allowed to read. */
	bytes: Uint8Array;
	/** The source file's name; its extension picks the importer. */
	name: string;
	/** Which stored source file this is (`previewOwner`). */
	owner: string;
	signal?: AbortSignal;
}

export interface PreviewResult {
	pdf: Buffer;
	/** True when the PDF was already stored and Gotenberg was not asked. */
	cached: boolean;
}

/**
 * The PDF preview of a file: the stored one when there is one, otherwise made
 * now, stored, and returned. Throws `ConversionError` when it cannot be made
 * (see gotenberg.ts) — the caller shows that as "no preview", never as a
 * broken file.
 */
export async function getOrCreatePreview(request: PreviewRequest): Promise<PreviewResult> {
	const sha = sourceSha256(request.bytes);
	const filename = previewFilename(sha);

	const stored = await readStored(filename, request.owner);
	if (stored) return { pdf: stored, cached: true };

	// One conversion per file name at a time in this process: a second viewer
	// of the same deck waits for the first one's PDF instead of asking again.
	let pending = making.get(filename);
	let mine = false;
	if (!pending) {
		mine = true;
		pending = (async () => {
			const pdf = await convertOfficeToPdf(request.bytes, request.name, { signal: request.signal });
			await writePreview(filename, pdf, sha, request.owner);
			await collapseDuplicates(filename);
		})().finally(() => making.delete(filename));
		making.set(filename, pending);
	}
	await pending;
	const made = await readStored(filename, request.owner);
	if (!made) throw new Error("The preview was made but could not be read back");
	return { pdf: made, cached: !mine };
}

/** The stored preview, with this owner added to it; undefined when there is none (or it cannot be read). */
async function readStored(filename: string, owner: string): Promise<Buffer | undefined> {
	const rows = await findRows(filename);
	if (rows.length === 0) return undefined;
	const row = rows[0];
	try {
		const pdf = await readBytes(row._id);
		if (pdf.byteLength === 0) return undefined;
		if (!row.metadata?.owners?.includes(owner)) {
			await collections.bucketFiles.updateOne(
				{ _id: row._id },
				{ $addToSet: { "metadata.owners": owner } }
			);
		}
		return pdf;
	} catch (err) {
		// An entry deleted between the lookup and the read (its last owner went):
		// the same as never having been there.
		logger.warn({ err, filename }, "office_preview_read_failed");
		return undefined;
	}
}

/**
 * Whether a produced file gets its preview straight away: model-generated
 * files are usually opened at once, so they are converted when stored rather
 * than on the first click. Everything else (an upload nobody may open) waits
 * for its first view.
 */
export function wantsEagerPreview(name: string, size: number): boolean {
	return isGotenbergEnabled() && isOfficeDocument(name) && size <= MAX_SOURCE_BYTES;
}

/**
 * Start making a produced file's preview without making anyone wait for it.
 * A failure is logged and forgotten: the first view then tries again.
 */
export function previewInBackground(request: PreviewRequest): void {
	void getOrCreatePreview(request).catch((err) =>
		logger.warn({ err, name: request.name }, "office_preview_eager_failed")
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Delete the entries that no source file uses any more. */
async function deleteUnowned(): Promise<number> {
	const rows = await collections.bucketFiles
		.find({ "metadata.preview": true, "metadata.owners": { $size: 0 } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	let removed = 0;
	for (const row of rows) {
		try {
			await collections.bucket.delete(row._id);
			removed += 1;
		} catch (err) {
			logger.warn({ err, fileId: row._id.toString() }, "office_preview_delete_failed");
		}
	}
	return removed;
}

/**
 * Tell the store that every source file of these conversations (or shares) is
 * gone, or going: their owners are removed from every preview, and a preview
 * left with none is deleted. A preview some other conversation's file still
 * uses stays.
 */
export async function releasePreviewOwners(
	kind: PreviewSourceKind,
	ownerTags: readonly string[]
): Promise<number> {
	if (ownerTags.length === 0) return 0;
	const patterns = ownerTags.map((tag) => new RegExp(`^${escapeRegExp(`${kind}:${tag}-`)}`));
	await collections.bucketFiles.updateMany(
		{ "metadata.preview": true, "metadata.owners": { $in: patterns } },
		{ $pull: { "metadata.owners": { $in: patterns } } } as never
	);
	return deleteUnowned();
}

/** The same for individual source files, named by their owner strings. */
export async function releasePreviewOwnerStrings(owners: readonly string[]): Promise<number> {
	if (owners.length === 0) return 0;
	await collections.bucketFiles.updateMany(
		{ "metadata.preview": true, "metadata.owners": { $in: [...owners] } },
		{ $pull: { "metadata.owners": { $in: [...owners] } } } as never
	);
	return deleteUnowned();
}

const SWEEP_BATCH = 200;

async function sourceExists(owner: string): Promise<boolean> {
	const sep = owner.indexOf(":");
	const kind = owner.slice(0, sep);
	const name = owner.slice(sep + 1);
	if (kind === "att") {
		return (
			(await collections.bucketFiles.findOne({ filename: name }, { projection: { _id: 1 } })) !==
			null
		);
	}
	if (kind === "out") {
		const dash = name.indexOf("-");
		const conversationId = name.slice(0, dash);
		const sha256 = name.slice(dash + 1);
		if (!ObjectId.isValid(conversationId)) return false;
		return (
			(await collections.codeExecutionOutputs.findOne(
				{ conversationId: new ObjectId(conversationId), sha256 },
				{ projection: { _id: 1 } }
			)) !== null
		);
	}
	// An owner this version does not know is somebody else's: keep it.
	return true;
}

/**
 * The backstop: drop the owners whose source file no longer exists and delete
 * the previews that end up with none. Also deletes the previews of an older
 * converter version: nothing reads them any more (the key names the version),
 * and their owners would otherwise keep them for ever. Returns how many
 * previews were deleted.
 */
export async function sweepOrphanPreviews(): Promise<number> {
	let removed = 0;
	let after: ObjectId | null = null;
	for (;;) {
		const page = (await collections.bucketFiles
			.find(
				after ? { "metadata.preview": true, _id: { $gt: after } } : { "metadata.preview": true }
			)
			.sort({ _id: 1 })
			.limit(SWEEP_BATCH)
			.toArray()) as PreviewRow[];
		if (page.length === 0) break;
		after = page[page.length - 1]._id;
		for (const row of page) {
			const owners = row.metadata?.owners ?? [];
			const dead: string[] = [];
			for (const owner of owners) if (!(await sourceExists(owner))) dead.push(owner);
			if (dead.length === 0) continue;
			await collections.bucketFiles.updateOne({ _id: row._id }, {
				$pull: { "metadata.owners": { $in: dead } },
			} as never);
		}
		if (page.length < SWEEP_BATCH) break;
	}
	const stale = await collections.bucketFiles
		.find({ "metadata.preview": true, "metadata.version": { $ne: CONVERTER_VERSION } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	for (const row of stale) {
		await collections.bucket.delete(row._id).then(
			() => {
				removed += 1;
			},
			(err) => logger.warn({ err, fileId: row._id.toString() }, "office_preview_delete_failed")
		);
	}
	removed += await deleteUnowned();
	if (removed > 0) logger.info({ count: removed }, "office_previews_swept");
	return removed;
}
