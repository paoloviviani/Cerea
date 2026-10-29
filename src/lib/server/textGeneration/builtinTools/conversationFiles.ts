import type { ObjectId } from "mongodb";
import { downloadDeliverable } from "$lib/server/execution/deliverables";
import {
	attachmentNamed,
	branchOf,
	numberedRows,
	onBranch,
	type Branch,
} from "$lib/server/execution/fileVersions";
import type { BuiltinToolContext } from "./types";
import { downloadFile } from "$lib/server/files/downloadFile";
import type { PlannedAttachment } from "$lib/utils/execution/attachmentNames";
import { MOUNT_ROOT } from "$lib/utils/execution/protocol";

/** The name as the model sees it for a file in the sandbox: `/mnt/data/<name>` or the bare name. */
export function bareName(reference: string): string {
	const trimmed = reference.trim();
	return trimmed.startsWith(`${MOUNT_ROOT}/`) ? trimmed.slice(MOUNT_ROOT.length + 1) : trimmed;
}

/** One version of a file: the attachment (when the name is one) or a produced file. */
export interface FileVersion {
	/** 1 = the original attachment or the first produced file; a version keeps its number for good. */
	version: number;
	origin: "attachment" | "output";
	sha256: string;
	at: Date;
	/** What made it: "attachment", "doc_edit", "doc_create", "convert_document", "sandbox"... */
	tool: string;
	summary?: string;
	/** The version the name resolves to now. */
	current: boolean;
	/** Stored rows only. */
	mime?: string;
}

export type ConversationFile =
	| {
			ok: true;
			name: string;
			bytes: Buffer;
			sha256: string;
			mime?: string;
			/** An attachment the person sent, or a file a run or a tool produced. */
			origin: "attachment" | "output";
			/** Which version these are (see `FileVersion`), and how many the file has. */
			version: number;
			versionCount: number;
			/** The version a plain name resolves to now. */
			currentVersion: number;
	  }
	| { ok: false; error: string };

/** What the optional `version` parameter of the file tools says: a number, or "previous". */
export type VersionRequest = number | "previous";

/** The `version` parameter every file tool takes (one definition, so the tools say the same thing). */
export const VERSION_PROPERTY = {
	description:
		'An earlier version of the file: 1 is the original, then 2, 3...; or "previous". ' +
		"Default: the latest. doc_outline lists a file's versions.",
	anyOf: [{ type: "integer" }, { type: "string" }],
};

export function parseVersion(
	value: unknown
): { ok: true; version: VersionRequest | undefined } | { ok: false; error: string } {
	if (value === undefined || value === null || value === "")
		return { ok: true, version: undefined };
	if (typeof value === "string" && /^previous$/i.test(value.trim())) {
		return { ok: true, version: "previous" };
	}
	const number =
		typeof value === "number"
			? value
			: /^\d{1,6}$/.test(String(value).trim())
				? Number(value)
				: NaN;
	if (Number.isInteger(number) && number >= 1) return { ok: true, version: number };
	return {
		ok: false,
		error: `\`version\` is a whole number from 1 (1 is the original) or "previous", not ${JSON.stringify(value)}.`,
	};
}

const branches = new WeakMap<BuiltinToolContext, Promise<Branch | undefined>>();

/**
 * The branch of the conversation tree the tool call runs on: the assistant message it writes into
 * and that message's ancestors (see `branchOf`). Worked out once per call; `undefined` when it
 * cannot be told, which leaves every version visible.
 */
export function branchOfCall(ctx: BuiltinToolContext): Promise<Branch | undefined> {
	if (!ctx.conversationId) return Promise.resolve(undefined);
	let found = branches.get(ctx);
	if (!found) {
		found = branchOf(ctx.conversationId, ctx.messageId);
		branches.set(ctx, found);
	}
	return found;
}

/** The text of a version list for an error or a result: "1 attachment; 2 doc_edit (...)". */
export function describeVersions(versions: readonly FileVersion[]): string {
	return versions
		.map(
			(v) =>
				`${v.version}${v.current ? " (latest)" : ""}: ${v.tool}${v.summary ? `, ${v.summary}` : ""}`
		)
		.join("; ");
}

/** The latest moment a stored version became the current one: restoring an old version sets `latestAt`. */
function becameCurrentAt(row: { createdAt: Date; latestAt?: Date | null }): number {
	return (row.latestAt ?? row.createdAt).getTime();
}

/**
 * Every version of the file a name stands for, oldest number first: the
 * attachment of that name and each stored file of that name. A stored version
 * keeps its number for good, and an attachment uploaded under a name that
 * already had versions was numbered at upload, so the numbers stay one series.
 * Restoring an old one does not copy it (the store keeps one row per distinct
 * content): the row is marked as current again, and the list says which is
 * current.
 */
export async function listFileVersions(
	conversationId: ObjectId,
	reference: string,
	branch?: Branch
): Promise<{ name: string; versions: FileVersion[]; attachment?: PlannedAttachment } | undefined> {
	const wanted = bareName(reference);
	const attachment = await attachmentNamed(conversationId, wanted, branch);
	// Numbers are the whole conversation's (a version keeps its number for good, whatever
	// branch made it); the list shows only what the branch can see.
	const rows = (await numberedRows(conversationId, wanted)).filter((row) => onBranch(row, branch));
	if (!attachment && rows.length === 0) return undefined;

	const versions: FileVersion[] = [];
	// The moment each entry last became the newest content of the name: a row
	// by `latestAt ?? createdAt` (a restore moves it forward), the attachment
	// by when its message was sent.
	const liveAt: number[] = [];
	if (attachment) {
		versions.push({
			// Numbered at upload when the name already had versions (a file
			// re-uploaded under a produced name takes the next free one); 1 when
			// it carries no number: the first version of its name.
			version: attachment.planned.file.version ?? 1,
			origin: "attachment",
			sha256: attachment.planned.file.value,
			at: attachment.at,
			tool: "attachment",
			summary: "uploaded by the user",
			current: false,
			mime: attachment.planned.file.mime,
		});
		liveAt.push(attachment.at.getTime());
	}
	for (const row of rows) {
		versions.push({
			// Stored with the row, so expiring older rows never renumbers it.
			version: row.version ?? versions.length + 1,
			origin: "output",
			sha256: row.sha256,
			at: row.createdAt,
			tool: row.tool ?? (row.derivedFromSha256 ? "document tool" : "sandbox"),
			...(row.summary ? { summary: row.summary } : {}),
			current: false,
			mime: row.mime,
		});
		liveAt.push(becameCurrentAt(row));
	}
	// The newest content of the name is current, produced file or attachment:
	// an attachment re-uploaded under the name is the newest by construction,
	// so the "(latest)" marker and the tools' default edit source land on it.
	// A tie goes to the entry built later (a row over an attachment sent in the
	// same millisecond), as the row-only comparison did before.
	let latest = 0;
	for (let i = 1; i < versions.length; i += 1) {
		if (liveAt[i] >= liveAt[latest]) latest = i;
	}
	versions[latest].current = true;
	// The numbers are the list's order, not the attachment-first one: an
	// attachment numbered at upload sits among the rows it follows.
	versions.sort((a, b) => a.version - b.version);
	return { name: attachment?.planned.name ?? wanted, versions, attachment: attachment?.planned };
}

/**
 * A file the conversation already has, by the name the model knows it under:
 * an attachment (the name in "available to code at /mnt/data/<name>") or a file
 * a run or a tool produced.
 *
 * Only this conversation's store is searched, and each read is checked against
 * the conversation again (`downloadFile`, `downloadDeliverable`), so a name or
 * a hash that belongs to somebody else's conversation is "not found", never
 * their bytes.
 *
 * `prefer` says which wins when an attachment and a produced file carry the
 * same name. The document tools (and `convert_document`, `look_doc`) take the
 * current version, whichever origin it is — an edit is saved under its source's
 * name as the next version, so the next edit must start from the newest
 * content, and a re-uploaded attachment is the newest by construction.
 * `branch` (the turn's message and its ancestors) limits all of it to what that branch of the
 * conversation tree made or was sent: another branch's versions are not here.
 * `version` picks one version outright (`listFileVersions` numbers them) and
 * ignores `prefer`.
 */
export async function findConversationFile(
	conversationId: ObjectId,
	reference: string,
	options: { prefer?: "attachment" | "output"; version?: VersionRequest; branch?: Branch } = {}
): Promise<ConversationFile> {
	const wanted = bareName(reference);
	const listing = await listFileVersions(conversationId, reference, options.branch);
	if (!listing) {
		return {
			ok: false,
			error: `No file named "${wanted}" in this conversation. Use the name of an attachment or of a file you produced.`,
		};
	}
	const { versions } = listing;
	const current = versions.find((v) => v.current) ?? versions[versions.length - 1];

	let pick: FileVersion | undefined;
	if (options.version !== undefined) {
		pick =
			options.version === "previous"
				? versions[versions.indexOf(current) - 1]
				: versions.find((v) => v.version === options.version);
		if (!pick) {
			return {
				ok: false,
				error:
					options.version === "previous"
						? `"${wanted}" has no version before its current one (version ${current.version}). Its versions: ${describeVersions(versions)}.`
						: `"${wanted}" has no version ${options.version}. Its versions: ${describeVersions(versions)}.`,
			};
		}
	} else if (options.prefer === "output") {
		pick = current;
	} else {
		// An attachment of that name first, as before the document tools — it is
		// the list's first entry only when it is version 1.
		const attachmentEntry = versions.find((v) => v.origin === "attachment");
		pick = listing.attachment && attachmentEntry ? attachmentEntry : current;
	}

	const read = async (entry: FileVersion): Promise<{ name: string; bytes: Buffer } | undefined> => {
		if (entry.origin === "attachment" && listing.attachment) {
			const stored = await downloadFile(
				listing.attachment.file.value,
				conversationId.toString()
			).catch(() => undefined);
			return stored
				? { name: listing.attachment.file.name, bytes: Buffer.from(stored.value, "base64") }
				: undefined;
		}
		const bytes = (await downloadDeliverable(conversationId, entry.sha256))?.buffer;
		return bytes ? { name: wanted, bytes } : undefined;
	};
	let found = await read(pick);
	if (!found && options.version === undefined && pick.origin === "output" && listing.attachment) {
		// A produced file whose bytes are gone: the attachment of that name is still the answer.
		pick = versions.find((v) => v.origin === "attachment") ?? current;
		found = await read(pick);
	}
	if (!found) {
		return {
			ok: false,
			error:
				options.version === undefined
					? `No file named "${wanted}" in this conversation. Use the name of an attachment or of a file you produced.`
					: `Version ${pick.version} of "${wanted}" is no longer stored.`,
		};
	}
	return {
		ok: true,
		name: found.name,
		bytes: found.bytes,
		sha256: pick.sha256,
		mime: pick.mime,
		origin: pick.origin,
		version: pick.version,
		versionCount: versions.length,
		currentVersion: current.version,
	};
}
