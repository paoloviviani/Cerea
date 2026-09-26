import { base } from "$app/paths";
import { getExecutionSession } from "$lib/utils/execution/runtime";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import type { MessageCodeExecutionOutputsUpdate } from "$lib/types/MessageUpdate";

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
	for (const f of files) {
		try {
			const data = await session.readFile(f.path);
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
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { files: PersistedDeliverableRef[] };
		return body.files ?? [];
	} catch {
		return [];
	}
}

/**
 * Attach a code block's or an artifact cell's uploaded files to the message
 * the code belongs to. The server rebuilds every ref from its own store and
 * answers with the record it keeps; `undefined` when it refused or failed.
 */
export async function recordRunFiles(options: {
	conversationId: string;
	messageId: string;
	runKey: string;
	files: PersistedDeliverableRef[];
}): Promise<MessageCodeExecutionOutputsUpdate | undefined> {
	if (options.files.length === 0) return undefined;
	try {
		const res = await fetch(
			`${base}/conversation/${options.conversationId}/code-execution/run-files`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messageId: options.messageId,
					runKey: options.runKey,
					sha256: options.files.map((f) => f.sha256),
				}),
			}
		);
		if (!res.ok) return undefined;
		const body = (await res.json()) as { update?: MessageCodeExecutionOutputsUpdate };
		return body.update;
	} catch {
		return undefined;
	}
}
