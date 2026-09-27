import { base } from "$app/paths";
import { getExecutionSession } from "$lib/utils/execution/runtime";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import type { MessageCodeExecutionOutputsUpdate } from "$lib/types/MessageUpdate";

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
	files: Array<{ path: string; size: number }>
): Promise<PersistedDeliverableRef[]> {
	if (files.length === 0) return [];
	const session = getExecutionSession();
	if (!session) return [];

	const form = new FormData();
	let any = false;
	let totalBytes = 0;
	for (const f of files) {
		try {
			const data = await session.readFile(f.path);
			totalBytes += data.byteLength;
			form.append("file", new Blob([data]), f.path.split("/").pop() || f.path);
			any = true;
		} catch {
			// Gone from the runtime already; the live outcome still names it.
		}
	}
	if (!any) return [];

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
						sha256: options.files.map((f) => f.sha256),
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
