import { base } from "$app/paths";

/** What "Delete older versions" answered. Counts only. */
export interface DeleteOlderResult {
	deleted: number;
	keptShared: number;
	freedFiles: number;
	/** Every deleted version of the conversation, as the registries' keys. */
	pruned: string[];
}

export async function deleteOlderVersions(input: {
	conversationId: string;
	identifier: string;
	leafMessageId?: string;
}): Promise<DeleteOlderResult> {
	const res = await fetch(`${base}/api/v2/artifacts/versions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as DeleteOlderResult;
}
