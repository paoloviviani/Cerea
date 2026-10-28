import type { Message } from "$lib/types/Message";
import { chatRunKey } from "./execution/keys";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageCodeExecutionOutputsUpdate,
} from "$lib/types/MessageUpdate";

/**
 * File artifacts: outputs a Pyodide run produced, promoted to first-class
 * artifacts.
 *
 * Like text artifacts these are derived from the messages — no separate
 * store. The durable side is the persisted `execute_code` deliverable: the
 * resolved update on an assistant message carries `files` references
 * (name + size + sha256) into the server-side output store (GridFS bucket
 * `codeOutputs`, metadata in `codeExecutionOutputs`), so the bytes survive
 * reloads and other devices without ever being duplicated. **Every** run's
 * files are persisted the same way, and so become file artifacts the same
 * way: an `execute_code` tool run's ride on its `Resolved` update; a chat code
 * block's or an artifact cell's on an `Outputs` update the browser records
 * once the run settles. How a file was produced changes nothing about how it
 * is kept or shown.
 *
 * Versioning mirrors text artifacts: every run that writes the same filename
 * appends a version, so a re-run that rewrites `report.pdf` is v2 of the
 * same artifact. A re-run with byte-identical output (same sha256) appends
 * nothing — the store itself dedupes those bytes.
 */

export interface FileArtifactVersion {
	name: string;
	size: number;
	sha256: string;
	/** 1-based version number within the file artifact. */
	version: number;
	messageId: Message["id"];
	/**
	 * False when the run produced these bytes but the store does not hold them
	 * (the browser's upload failed): the card says "not saved". Anything else,
	 * records written before the field included, is stored.
	 */
	uploaded?: boolean;
	/**
	 * Key of the run that produced it, so a retried upload can be recorded
	 * under the same run. For an `execute_code` tool run it is the chat key of
	 * the code the run was asked to execute.
	 */
	runKey?: string;
}

export interface FileArtifact {
	/** The filename; doubles as the artifact identifier. */
	name: string;
	versions: FileArtifactVersion[];
}

export interface FileArtifactRegistry {
	artifacts: Map<string, FileArtifact>;
}

type FileMessage = Pick<Message, "id" | "from" | "updates">;

/**
 * Walk the visible messages in order and fold every persisted run output —
 * tool runs, code blocks, artifact cells — into versioned file artifacts,
 * keyed by filename.
 */
export function collectFileArtifacts(messages: FileMessage[]): FileArtifactRegistry {
	const artifacts = new Map<string, FileArtifact>();
	for (const message of messages) {
		if (message.from !== "assistant") continue;
		const requests = new Map<string, string>();
		for (const update of message.updates ?? []) {
			if (
				update.type === MessageUpdateType.CodeExecution &&
				update.subtype === MessageCodeExecutionUpdateType.Request
			) {
				requests.set(update.executionId, chatRunKey(update.code));
			}
		}
		for (const update of message.updates ?? []) {
			if (
				update.type !== MessageUpdateType.CodeExecution ||
				(update.subtype !== MessageCodeExecutionUpdateType.Resolved &&
					update.subtype !== MessageCodeExecutionUpdateType.Outputs)
			) {
				continue;
			}
			const runKey =
				update.subtype === MessageCodeExecutionUpdateType.Outputs
					? update.runKey
					: requests.get(update.executionId);
			for (const file of update.files ?? []) {
				if (!file?.name || !file?.sha256) continue;
				let artifact = artifacts.get(file.name);
				if (!artifact) {
					artifact = { name: file.name, versions: [] };
					artifacts.set(file.name, artifact);
				}
				// The same file produced again (byte-identical) is the same
				// version: it appends nothing, but a record that says the bytes
				// are stored upgrades a version first seen as not saved (a
				// retried upload, or the live entry the server's record
				// replaces).
				const last = artifact.versions.at(-1);
				if (last?.sha256 === file.sha256) {
					if (last.uploaded === false && file.uploaded !== false) last.uploaded = true;
					continue;
				}
				artifact.versions.push({
					name: file.name,
					size: file.size,
					sha256: file.sha256,
					version: artifact.versions.length + 1,
					messageId: message.id,
					...(file.uploaded === false ? { uploaded: false } : {}),
					...(runKey ? { runKey } : {}),
				});
			}
		}
	}
	return { artifacts };
}

/**
 * Every version carrying these exact bytes, for deep-linking a store row.
 * Identical bytes can sit under several names (`a.csv` copied to `b.csv`), so
 * the answer is all of them, newest name last in registry order.
 */
export function findFileVersionsBySha(
	registry: FileArtifactRegistry,
	sha256: string
): Array<{ name: string; version: number }> {
	const found: Array<{ name: string; version: number }> = [];
	for (const artifact of registry.artifacts.values()) {
		for (const v of artifact.versions) {
			if (v.sha256 === sha256) found.push({ name: artifact.name, version: v.version });
		}
	}
	return found;
}

/**
 * The version carrying these exact bytes. When the bytes are under more than
 * one name, `preferredName` (the name the caller's own card shows) wins, then
 * the latest version of the first name; never just whichever name the
 * registry happened to hold first.
 */
export function findFileVersionBySha(
	registry: FileArtifactRegistry,
	sha256: string,
	preferredName?: string
): { name: string; version: number } | undefined {
	const all = findFileVersionsBySha(registry, sha256);
	if (all.length === 0) return undefined;
	if (preferredName) {
		const own = all.filter((f) => f.name === preferredName);
		if (own.length > 0) return own.at(-1);
	}
	return all[0];
}

export interface DeliverableRow {
	name: string;
	mime: string;
	size: number;
	sha256: string;
	createdAt: string;
	/** Set when an older version was made the latest again (a restore). */
	latestAt?: string;
}

/** When a row last became its file's current version: a restore counts, not only the first save. */
const liveAt = (row: Partial<DeliverableRow>): number =>
	Date.parse(row.latestAt ?? row.createdAt ?? "") || 0;

/**
 * One row per filename for the outputs list: the store keeps a row per
 * upload, so a re-run that rewrote `report.pdf` leaves two rows for one
 * file. The list shows the current one, the row that last became current
 * (`latestAt ?? createdAt`, the order the server sorts by), and the artifact
 * panel owns the older versions — the same file is never shown twice.
 */
export function dedupeDeliverablesByName<
	T extends Pick<DeliverableRow, "name"> & Partial<DeliverableRow>,
>(rows: T[]): T[] {
	const ordered = [...rows].sort((a, b) => liveAt(b) - liveAt(a));
	const seen = new Set<string>();
	return ordered.filter((row) => {
		if (seen.has(row.name)) return false;
		seen.add(row.name);
		return true;
	});
}

/**
 * Add the output-file records this tab made since the conversation loaded to
 * the messages they belong to, skipping any the loader already served (same
 * run, same files). Only messages that gain something are copied.
 */
export function withLiveRunFiles<T extends FileMessage>(
	messages: T[],
	live: Record<string, MessageCodeExecutionOutputsUpdate[]>
): T[] {
	if (Object.keys(live).length === 0) return messages;
	const fingerprint = (u: MessageCodeExecutionOutputsUpdate) =>
		`${u.runKey}|${u.files.map((f) => f.sha256 + (f.uploaded === false ? "!" : "")).join(",")}`;
	return messages.map((message) => {
		const extra = live[message.id];
		if (!extra?.length) return message;
		// What the loader already served on this message: Outputs records by
		// fingerprint, and every sha a stored run (tool or block) carries, so a
		// tool run's file is not added a second time by its live entry.
		const served = new Set<string>();
		const servedAny = new Set<string>();
		const servedStored = new Set<string>();
		for (const u of message.updates ?? []) {
			if (u.type !== MessageUpdateType.CodeExecution) continue;
			if (u.subtype === MessageCodeExecutionUpdateType.Outputs) served.add(fingerprint(u));
			if (
				u.subtype === MessageCodeExecutionUpdateType.Outputs ||
				u.subtype === MessageCodeExecutionUpdateType.Resolved
			) {
				for (const f of u.files ?? []) {
					servedAny.add(f.sha256);
					if (f.uploaded !== false) servedStored.add(f.sha256);
				}
			}
		}
		const missing: MessageCodeExecutionOutputsUpdate[] = [];
		for (const u of extra) {
			const key = fingerprint(u);
			// A record that says "stored" for bytes only served as "not saved"
			// is news (a retried upload); anything the loader covers is not.
			const covered = u.files.every(
				(f) => servedStored.has(f.sha256) || (f.uploaded === false && servedAny.has(f.sha256))
			);
			if (served.has(key) || covered) continue;
			served.add(key);
			missing.push(u);
		}
		return missing.length
			? { ...message, updates: [...(message.updates ?? []), ...missing] }
			: message;
	});
}
