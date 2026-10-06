import type { ObjectId } from "mongodb";
import type { ExtractionFailureKind } from "./Message";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * One context document of a project: a file whose extracted text goes into the
 * prompt of every conversation in the project, **in full**.
 *
 * That is what separates it from a knowledge base (searched, a few passages
 * per question) and is why the project's documents share one character budget
 * (`PROJECT_DOCUMENTS_MAX_CHARS`, in `$lib/types/Memory` beside the memory
 * limits): everything here is paid for on every message.
 *
 * ## Where the bytes are
 *
 * The row is the index; the content is in the chat's GridFS bucket under the
 * owner key `project:<projectId>` (`projectDocuments.ts`), tagged with this
 * row's id as `metadata.messageId`. The original is kept whatever happened to
 * the extraction. Deleting the project, the document or an account that owned
 * the project removes the entries; the orphan sweep is the backstop.
 *
 * ## Extraction happens once
 *
 * At upload, through the same reader as chat attachments (`/v1/ocr` is priced
 * per page). The text is its own GridFS entry, named by `extractedSha`. A
 * failed extraction leaves a `failed` row carrying the reason and **no text**:
 * it stays listed so nobody wonders where their file went, and contributes
 * nothing to the prompt.
 *
 * ## Who may touch it
 *
 * Everyone who can see the project, as for project memory
 * (`$lib/types/ProjectMemory`): the document is the project's by then, not its
 * uploader's. The uploader stays on the row for display; once their account is
 * erased it reads "deleted user" and the document stays, unless the project
 * was theirs, in which case it goes with the project.
 */
export interface ProjectDocument extends Timestamps {
	_id: ObjectId;
	projectId: ObjectId;
	/** The file's own name. */
	name: string;
	/** The type the bytes were treated as (sniffed, else the browser's). */
	mime: string;
	/** Size of the original, in bytes. */
	bytes: number;
	/** Hash of the original, as in the bucket's entry name. */
	sha: string;
	/** Hash of the extracted text's entry; absent when extraction failed. */
	extractedSha?: string;
	/** Length of the extracted text; `0` when extraction failed. */
	chars: number;
	pages?: number;
	status: "ready" | "failed";
	failure?: { kind: ExtractionFailureKind; reason: string };
	addedByUserId: User["_id"];
}

/** What the page is given. */
export interface ProjectDocumentView {
	id: string;
	name: string;
	mime: string;
	bytes: number;
	chars: number;
	status: "ready" | "failed";
	failure?: { kind: ExtractionFailureKind; reason: string };
	/** A display name, or "deleted user" once the account is gone. */
	addedBy: string;
	/** Whether the viewer added it. */
	mine: boolean;
	createdAt: string;
}
