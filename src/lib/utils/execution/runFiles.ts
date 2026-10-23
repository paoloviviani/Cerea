import { base } from "$app/paths";
import { getExecutionSession } from "$lib/utils/execution/runtime";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageCodeExecutionOutputsUpdate,
} from "$lib/types/MessageUpdate";
import { runFiles } from "$lib/stores/runFiles.svelte";
import { cachedFileBytes, fileBaseName, runFileName, type RunOutputFile } from "./fileIdentity";

/**
 * A run's own output listing renders the instant the sandbox lists it — well
 * before this module's uploads even start — so a person who reloads right
 * after seeing a file has no visual cue that anything is still in flight.
 * `keepalive` keeps that upload (and the small record POST below) alive past
 * the reload's page-unload instead of losing it. Chromium enforces a 64KB
 * *combined* cap across every in-flight keepalive body on a page; staying
 * comfortably under it here leaves room for the tiny run-files POST too. A
 * bigger upload keeps the ordinary (pre-existing) risk of a lost upload on an
 * immediate reload — no worse than before this module ever ran keepalive.
 */
const KEEPALIVE_SAFE_BYTES = 60_000;

/**
 * Upload a settled run's output files to the conversation's deliverable store
 * (per-user, 30-day TTL, content-addressed — `$lib/server/execution/deliverables.ts`).
 *
 * One upload for every path that runs code — the `execute_code` card, a chat
 * code block, an artifact cell — so a produced file is kept the same way
 * however it came to exist. A file the runtime can no longer read (removed
 * mid-run) is skipped rather than failing the rest; the live output still
 * names it.
 */
export async function uploadRunFiles(
	conversationId: string,
	files: Array<{ path: string; sha256?: string }>
): Promise<PersistedDeliverableRef[]> {
	if (files.length === 0) return [];
	const session = getExecutionSession();

	const form = new FormData();
	let any = false;
	let totalBytes = 0;
	for (const f of files) {
		try {
			// The bytes read when the file was fingerprinted, when still held:
			// what is uploaded is then exactly what the sha256 names, even if
			// the sandbox file was rewritten since.
			const kept = f.sha256 ? cachedFileBytes(f.sha256) : undefined;
			const data = kept ?? (session ? await session.readFile(f.path) : undefined);
			if (!data) continue;
			totalBytes += data.byteLength;
			form.append("file", new Blob([data as Uint8Array<ArrayBuffer>]), fileBaseName(f.path));
			any = true;
		} catch {
			// Gone from the runtime already; the live outcome still names it.
		}
	}
	if (!any) return [];

	return postUpload(conversationId, form, totalBytes);
}

async function postUpload(
	conversationId: string,
	form: FormData,
	totalBytes: number
): Promise<PersistedDeliverableRef[]> {
	try {
		const res = await fetch(`${base}/conversation/${conversationId}/code-execution/output`, {
			method: "POST",
			body: form,
			...(totalBytes <= KEEPALIVE_SAFE_BYTES ? { keepalive: true } : {}),
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { files: PersistedDeliverableRef[] };
		return body.files ?? [];
	} catch {
		return [];
	}
}

/**
 * Upload a run's files and describe what the run produced, whether or not
 * the upload worked: one reference per file, named by the run's own relative
 * path and the sha256 computed in the browser, `uploaded` true only when the
 * store answered with that sha. A failed save therefore still leaves a
 * record, and the card says "not saved" instead of the file vanishing.
 */
export async function uploadAndDescribe(
	conversationId: string,
	files: RunOutputFile[]
): Promise<PersistedDeliverableRef[]> {
	const stored = await uploadRunFiles(conversationId, files);
	const storedShas = new Set(stored.map((ref) => ref.sha256));
	return describeRunFiles(files, storedShas);
}

/** The references for a run's files; `storedShas` undefined leaves `uploaded` unset (in flight). */
export function describeRunFiles(
	files: RunOutputFile[],
	storedShas?: Set<string>
): PersistedDeliverableRef[] {
	return files.map((f) => ({
		name: runFileName(f.path),
		size: f.size,
		sha256: f.sha256,
		...(storedShas ? { uploaded: storedShas.has(f.sha256) } : {}),
	}));
}

/**
 * Put a run's files in this tab's live registry feed the moment they are
 * fingerprinted, under the message the run belongs to.
 */
export function noteLiveRunFiles(
	messageId: string,
	runKey: string,
	files: PersistedDeliverableRef[]
): void {
	if (files.length === 0) return;
	runFiles.setLive(messageId, {
		type: MessageUpdateType.CodeExecution,
		subtype: MessageCodeExecutionUpdateType.Outputs,
		runKey,
		files,
	});
}

/**
 * Upload a file that was not saved the first time from the bytes this tab
 * still holds, then record it as stored. Resolves true when the store now
 * has it; false when the bytes are gone from this tab or the upload failed
 * again.
 */
export async function retryFileUpload(options: {
	conversationId: string;
	messageId: string;
	runKey: string;
	file: { name: string; size: number; sha256: string };
}): Promise<boolean> {
	const bytes = cachedFileBytes(options.file.sha256);
	if (!bytes) return false;
	const form = new FormData();
	form.append(
		"file",
		new Blob([bytes as Uint8Array<ArrayBuffer>]),
		fileBaseName(options.file.name)
	);
	const stored = await postUpload(options.conversationId, form, bytes.byteLength);
	if (!stored.some((ref) => ref.sha256 === options.file.sha256)) return false;
	const update = await recordRunFiles({
		conversationId: options.conversationId,
		messageId: options.messageId,
		runKey: options.runKey,
		files: [{ name: options.file.name, size: options.file.size, sha256: options.file.sha256 }],
	});
	if (update) runFiles.add(options.messageId, update);
	// Even when the record is refused the bytes are stored: the live entry
	// shows them as saved until the next load reads the server's own record.
	else
		noteLiveRunFiles(options.messageId, options.runKey, [
			{
				name: options.file.name,
				size: options.file.size,
				sha256: options.file.sha256,
				uploaded: true,
			},
		]);
	return true;
}

/** Waits between retries of a record the server refused with 409 ("message
 * not saved yet"): about ten seconds in all, the time a turn's save takes. */
export const RECORD_RETRY_DELAYS_MS = [1000, 3000, 6000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attach a code block's or an artifact cell's uploaded files to the message
 * the code belongs to. The server rebuilds every ref from its own store and
 * answers with the record it keeps; `undefined` when it refused or failed.
 *
 * A 409 means the message is not saved under that id yet: the turn's save
 * can land after the run settles without the id changing at all, so nothing
 * would re-trigger the caller. The record is retried here instead, a few
 * times over about ten seconds, each time under the message's current id
 * (`currentMessageId`, when given), which also covers an id swapped from the
 * client-minted one to the server's meanwhile. Any other failure is final.
 */
export async function recordRunFiles(options: {
	conversationId: string;
	messageId: string;
	/** The message's id right now, read again before each retry. */
	currentMessageId?: () => string | undefined;
	runKey: string;
	files: PersistedDeliverableRef[];
	retryDelaysMs?: number[];
}): Promise<MessageCodeExecutionOutputsUpdate | undefined> {
	if (options.files.length === 0) return undefined;
	const delays = options.retryDelaysMs ?? RECORD_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		const messageId =
			attempt === 0 ? options.messageId : (options.currentMessageId?.() ?? options.messageId);
		let status: number;
		try {
			const res = await fetch(
				`${base}/conversation/${options.conversationId}/code-execution/run-files`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messageId,
						runKey: options.runKey,
						files: options.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
					}),
					// Always small (hashes only): safe to keep alive past an unload
					// unconditionally, unlike the byte upload above.
					keepalive: true,
				}
			);
			if (res.ok) {
				const body = (await res.json()) as { update?: MessageCodeExecutionOutputsUpdate };
				return body.update;
			}
			status = res.status;
		} catch {
			return undefined;
		}
		if (status !== 409 || attempt >= delays.length) return undefined;
		await sleep(delays[attempt]);
	}
}
