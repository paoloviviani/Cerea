import type { Message } from "$lib/types/Message";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

/**
 * File artifacts: outputs a Pyodide run produced, promoted to first-class
 * artifacts.
 *
 * Like text artifacts these are derived from the messages — no separate
 * store. The durable side is the persisted `execute_code` deliverable: the
 * resolved update on an assistant message carries `files` references
 * (name + size + sha256) into the server-side output store (GridFS bucket
 * `codeOutputs`, metadata in `codeExecutionOutputs`), so the bytes survive
 * reloads and other devices without ever being duplicated. Only persisted
 * tool-run outputs become file artifacts: chat-fence and artifact-cell
 * scratch files stay session-only by the deliberate deliverables rule (see
 * `$lib/server/execution/deliverables.ts`), and dead references cannot back
 * a versioned artifact.
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
 * Walk the visible messages in order and fold persisted `execute_code`
 * outputs into versioned file artifacts, keyed by filename.
 */
export function collectFileArtifacts(messages: FileMessage[]): FileArtifactRegistry {
	const artifacts = new Map<string, FileArtifact>();
	for (const message of messages) {
		if (message.from !== "assistant") continue;
		for (const update of message.updates ?? []) {
			if (
				update.type !== MessageUpdateType.CodeExecution ||
				update.subtype !== MessageCodeExecutionUpdateType.Resolved
			) {
				continue;
			}
			for (const file of update.files ?? []) {
				if (!file?.name || !file?.sha256) continue;
				let artifact = artifacts.get(file.name);
				if (!artifact) {
					artifact = { name: file.name, versions: [] };
					artifacts.set(file.name, artifact);
				}
				// Byte-identical re-runs share the store row already; they add
				// no new version here either.
				if (artifact.versions.at(-1)?.sha256 === file.sha256) continue;
				artifact.versions.push({
					name: file.name,
					size: file.size,
					sha256: file.sha256,
					version: artifact.versions.length + 1,
					messageId: message.id,
				});
			}
		}
	}
	return { artifacts };
}

/** Find the version carrying these exact bytes, for deep-linking a store row. */
export function findFileVersionBySha(
	registry: FileArtifactRegistry,
	sha256: string
): { name: string; version: number } | undefined {
	for (const artifact of registry.artifacts.values()) {
		const found = artifact.versions.find((v) => v.sha256 === sha256);
		if (found) return { name: artifact.name, version: found.version };
	}
	return undefined;
}

export interface DeliverableRow {
	name: string;
	mime: string;
	size: number;
	sha256: string;
	createdAt: string;
}

/**
 * One row per filename for the outputs list: the store keeps a row per
 * upload, so a re-run that rewrote `report.pdf` leaves two rows for one
 * file. The list shows the newest (the server already sorts newest first)
 * and the artifact panel owns the older versions — the same file is never
 * shown twice.
 */
export function dedupeDeliverablesByName<T extends Pick<DeliverableRow, "name">>(rows: T[]): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		if (seen.has(row.name)) return false;
		seen.add(row.name);
		return true;
	});
}
