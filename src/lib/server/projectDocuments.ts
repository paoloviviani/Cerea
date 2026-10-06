/**
 * A project's context documents: files whose extracted text rides every prompt
 * in that project, in full. Read `$lib/types/ProjectDocument` first; this is
 * the machinery, and the rules worth knowing before changing it are here.
 *
 * **One reader, one path.** A document is stored and read exactly as a chat
 * attachment is (`writeAttachment`): same sniffing, same extractor, same
 * failure reasons, same legacy `.doc` handling. The only addition is plain
 * text, which chat inlines from the original and which here gets an extracted
 * entry of its own, so every document is read from one place at prompt time.
 *
 * **The budget is enforced where the cost is known.** The extractor bills per
 * page, so a project already at its limit refuses *before* extracting; the
 * character count is only known after, so a file that tips the total over is
 * extracted, refused and removed again. A second check after the row is
 * inserted closes the race between two uploads that each fit alone.
 *
 * **A failed extraction is a row, not an error.** It is listed with its reason
 * and adds nothing to the prompt. The original is kept, as in chat.
 *
 * **Content is owner-keyed to the project**: `project:<id>`, with the
 * document's row id as the `messageId` tag, so deleting one document, the
 * project or an owner's account is a delete-by-tag, and the orphan sweep has
 * a key shape to check against `projects`.
 */

import { ObjectId } from "mongodb";
import { fileTypeFromBuffer } from "file-type";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { sha256 } from "$lib/utils/sha256";
import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";
import { MAX_ATTACHMENT_BYTES, TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
import { PROJECT_DOCUMENTS_MAX_CHARS, PROJECT_DOCUMENTS_MAX_COUNT } from "$lib/types/Memory";
import type { ProjectDocument, ProjectDocumentView } from "$lib/types/ProjectDocument";
import type { User } from "$lib/types/User";
import { documentMime, isExtractableDocument } from "$lib/server/files/extractDocument";
import { deleteAttachments, deleteAttachmentsForMessage } from "$lib/server/files/attachmentStore";
import { store, writeAttachment } from "$lib/server/files/uploadFile";

export const DELETED_UPLOADER = "deleted user";

/** Why a project at its limit says no: the same sentence the page warns with. */
export const LARGE_CONTEXT_WARNING =
	"Large context makes every message in this project slower and more expensive.";

export class ProjectDocumentError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409 | 413 | 415 = 400
	) {
		super(message);
	}
}

export function projectOwnerKey(projectId: ObjectId | string): string {
	return `project:${projectId.toString()}`;
}

/** `project:<24 hex>` -> the id, for the orphan sweep. */
export function parseProjectOwnerKey(key: string): string | null {
	return /^project:([0-9a-f]{24})$/.exec(key)?.[1] ?? null;
}

/** Extensions read as text when the browser sent no useful type (`.md` often has none). */
const TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"csv",
	"tsv",
	"json",
	"xml",
	"yaml",
	"yml",
	"log",
	"rst",
	"html",
	"htm",
	"tex",
	"ini",
	"toml",
]);

function extensionOf(name: string): string {
	return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

/** The text type to treat a file as, or `null` when it is not text. */
function textMime(file: File): string | null {
	const declared = file.type.split(";")[0].trim();
	if (declared && mimeMatchesAllowlist(declared, [...TEXT_MIME_ALLOWLIST])) return declared;
	const ext = extensionOf(file.name);
	if (!TEXT_EXTENSIONS.has(ext)) return null;
	return ext === "md" || ext === "markdown" ? "text/markdown" : "text/plain";
}

export async function listProjectDocuments(projectId: ObjectId): Promise<ProjectDocument[]> {
	return collections.projectDocuments.find({ projectId }).sort({ createdAt: 1, _id: 1 }).toArray();
}

/** Characters the project's readable documents put in every prompt. */
export async function projectDocumentChars(projectId: ObjectId): Promise<number> {
	const [row] = await collections.projectDocuments
		.aggregate<{ total: number }>([
			{ $match: { projectId, status: "ready" } },
			{ $group: { _id: null, total: { $sum: "$chars" } } },
		])
		.toArray();
	return row?.total ?? 0;
}

function overBudget(total: number, adding?: number): ProjectDocumentError {
	return new ProjectDocumentError(
		(adding === undefined
			? `This project's documents already fill its ${PROJECT_DOCUMENTS_MAX_CHARS.toLocaleString("en-US")}-character limit. `
			: `Adding this document would bring the project's documents to ${(total + adding).toLocaleString("en-US")} characters, past the ${PROJECT_DOCUMENTS_MAX_CHARS.toLocaleString("en-US")} limit. `) +
			`${LARGE_CONTEXT_WARNING} Remove a document first.`,
		413
	);
}

/** The extracted text of one stored document; empty when there is none. */
async function readExtractedText(doc: ProjectDocument): Promise<string> {
	if (!doc.extractedSha) return "";
	const file = await collections.bucket
		.find({
			"metadata.conversation": projectOwnerKey(doc.projectId),
			"metadata.messageId": doc._id.toString(),
			"metadata.extractedFrom": doc.sha,
		})
		.next();
	if (!file) return "";
	const chunks: Uint8Array[] = [];
	for await (const chunk of collections.bucket.openDownloadStream(file._id)) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Add one file to a project. The caller has checked that the person may see
 * the project; `token` is their gateway token, so extraction is billed to them
 * as it is in chat.
 */
export async function addProjectDocument(options: {
	projectId: ObjectId;
	file: File;
	userId: User["_id"];
	token?: string;
}): Promise<ProjectDocument> {
	const { projectId, file, userId, token } = options;
	if (file.size > MAX_ATTACHMENT_BYTES) {
		throw new ProjectDocumentError(
			`${file.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
			413
		);
	}
	const existing = await listProjectDocuments(projectId);
	if (existing.length >= PROJECT_DOCUMENTS_MAX_COUNT) {
		throw new ProjectDocumentError(
			`A project holds at most ${PROJECT_DOCUMENTS_MAX_COUNT} documents.`,
			413
		);
	}
	const used = existing.reduce((sum, doc) => sum + (doc.status === "ready" ? doc.chars : 0), 0);
	if (used >= PROJECT_DOCUMENTS_MAX_CHARS) throw overBudget(used);

	const buffer = await file.arrayBuffer();
	const sniffed = await fileTypeFromBuffer(buffer).then((type) => type?.mime ?? file.type);
	const documentType = documentMime(sniffed, file.name);
	const asText = isExtractableDocument(documentType) ? null : textMime(file);
	if (!isExtractableDocument(documentType) && !asText) {
		throw new ProjectDocumentError(
			`${file.name} is not a type a project can read. Add a text file (.txt, .md, .csv, .json…) ` +
				"or a document (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB).",
			415
		);
	}

	// The writer names an entry by this hash, so a second copy of one file is
	// known before anything is extracted (and billed).
	const earlySha = await sha256(await file.text());
	if (existing.some((doc) => doc.sha === earlySha)) {
		throw new ProjectDocumentError(`${file.name} is already one of this project's documents.`, 409);
	}

	const _id = new ObjectId();
	const messageId = _id.toString();
	const ownerKey = projectOwnerKey(projectId);
	const forget = () =>
		deleteAttachmentsForMessage(ownerKey, messageId).catch((err) =>
			logger.warn({ err, projectId: ownerKey }, "project_document_cleanup_failed")
		);

	try {
		// Documents go through the chat's writer; text is stored by it as bytes
		// and read here. Either way the original lands first.
		const typed = asText ? new File([buffer], file.name, { type: asText }) : file;
		const written = await writeAttachment(typed, ownerKey, token, { messageId });

		let extractedSha: string | undefined;
		let text = "";
		let pages: number | undefined;
		let failure: ProjectDocument["failure"];
		if (asText) {
			text = new TextDecoder("utf-8", { fatal: false }).decode(buffer).trim();
			if (text.includes("\u0000")) {
				throw new ProjectDocumentError(`${file.name} does not look like a text file.`, 415);
			}
			if (!text) failure = { kind: "empty", reason: "The file has no text in it." };
			else {
				extractedSha = await sha256(text);
				await store(`${ownerKey}-${extractedSha}`, Buffer.from(text, "utf-8"), {
					conversation: ownerKey,
					mime: "text/markdown",
					messageId,
					sha: extractedSha,
					extractedFrom: written.value,
					pages: 0,
				});
			}
		} else if (written.extracted) {
			extractedSha = written.extracted.value;
			pages = written.extracted.pages;
		} else {
			failure = written.extractionError ?? {
				kind: "unsupported",
				reason: "No text could be read from this document.",
			};
		}
		const sha = written.value;

		const now = new Date();
		const row: ProjectDocument = {
			_id,
			projectId,
			name: file.name,
			mime: written.mime ?? typed.type,
			bytes: file.size,
			sha,
			...(extractedSha ? { extractedSha } : {}),
			chars: 0,
			...(pages !== undefined ? { pages } : {}),
			status: failure ? "failed" : "ready",
			...(failure ? { failure } : {}),
			addedByUserId: userId,
			createdAt: now,
			updatedAt: now,
		};
		if (!asText && extractedSha) {
			// A document's length is only known once it has been read.
			row.chars = (await readExtractedText(row)).length;
		} else if (asText && extractedSha) {
			row.chars = text.length;
		}
		if (row.status === "ready" && row.chars === 0) {
			row.status = "failed";
			row.failure = { kind: "empty", reason: "The document was read but no text was found." };
			delete row.extractedSha;
		}
		if (row.chars + used > PROJECT_DOCUMENTS_MAX_CHARS) throw overBudget(used, row.chars);

		await collections.projectDocuments.insertOne(row);
		// Two uploads that each fit alone can still tip it over together.
		if ((await projectDocumentChars(projectId)) > PROJECT_DOCUMENTS_MAX_CHARS) {
			await collections.projectDocuments.deleteOne({ _id });
			throw overBudget(used, row.chars);
		}
		if (row.status === "failed") {
			logger.info(
				{ project: ownerKey, filename: file.name, kind: row.failure?.kind },
				"project_document_text_unavailable: kept, listed with its reason"
			);
		}
		return row;
	} catch (err) {
		await forget();
		throw err;
	}
}

/** The page's rows: who added each, and "deleted user" when that account is gone. */
export async function projectDocumentViews(
	projectId: ObjectId,
	viewerId: User["_id"]
): Promise<ProjectDocumentView[]> {
	const rows = await listProjectDocuments(projectId);
	const ids = [
		...new Map(rows.map((row) => [row.addedByUserId.toString(), row.addedByUserId])).values(),
	];
	const users =
		ids.length > 0
			? await collections.users
					.find({ _id: { $in: ids } })
					.project<{ _id: ObjectId; name?: string; username?: string }>({ name: 1, username: 1 })
					.toArray()
			: [];
	const names = new Map(users.map((user) => [user._id.toString(), user.name || user.username]));
	return rows.map((row) => {
		const key = row.addedByUserId.toString();
		return {
			id: row._id.toString(),
			name: row.name,
			mime: row.mime,
			bytes: row.bytes,
			chars: row.chars,
			status: row.status,
			...(row.failure ? { failure: row.failure } : {}),
			addedBy: names.has(key) ? (names.get(key) ?? "a member") : DELETED_UPLOADER,
			mine: row.addedByUserId.equals(viewerId),
			createdAt: row.createdAt.toISOString(),
		};
	});
}

/** Remove one document and its stored entries. `false` when it is not this project's. */
export async function deleteProjectDocument(
	projectId: ObjectId,
	documentId: ObjectId
): Promise<boolean> {
	const { deletedCount } = await collections.projectDocuments.deleteOne({
		_id: documentId,
		projectId,
	});
	if (deletedCount === 0) return false;
	await deleteAttachmentsForMessage(projectOwnerKey(projectId), documentId.toString());
	return true;
}

/** Everything a project holds, for the project's own deletion. */
export async function deleteProjectDocuments(projectId: ObjectId): Promise<number> {
	const { deletedCount } = await collections.projectDocuments.deleteMany({ projectId });
	await deleteAttachments(projectOwnerKey(projectId));
	return deletedCount;
}

/**
 * The "Project documents" block for one project's chats, or `undefined`.
 *
 * Every readable document in full, each under its own name, oldest first. A
 * failed one is left out entirely: the page says why it failed, and a line in
 * the prompt about a file the model never saw would only invite it to guess.
 * The budget is enforced at upload, so nothing here truncates.
 */
export async function buildProjectDocumentsBlock(projectId: ObjectId): Promise<string | undefined> {
	const rows = (await listProjectDocuments(projectId)).filter(
		(doc) => doc.status === "ready" && doc.extractedSha
	);
	if (rows.length === 0) return undefined;
	const sections: string[] = [];
	for (const doc of rows) {
		const text = (await readExtractedText(doc)).trim();
		if (text) sections.push(`## ${doc.name}\n${text}`);
	}
	if (sections.length === 0) return undefined;
	return (
		"Project documents: files the members of this project attached to it, given here in full " +
		"and carried into every conversation in it. Use them where they are relevant, say which " +
		`one you used, and ignore them where they are not.\n\n${sections.join("\n\n")}`
	);
}
