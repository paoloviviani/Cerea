import { base } from "$app/paths";
import { handleResponse } from "$lib/APIClient";

/**
 * Ask the server to write a chat's title again ("Regenerate title" in a chat's
 * menu). Resolves with the new title; rejects with a message that is fit to
 * show (the server's own words: a title the user typed is never replaced).
 */
export async function regenerateChatTitle(id: string): Promise<string> {
	const res = await fetch(`${base}/api/v2/conversations/${encodeURIComponent(id)}/title`, {
		method: "POST",
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new Error(body?.message ?? res.statusText);
	}
	const { title } = handleResponse({ data: await res.text(), error: null, status: res.status }) as {
		title: string;
	};
	return title;
}
