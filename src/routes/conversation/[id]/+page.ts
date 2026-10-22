import { useAPIClient, handleResponse } from "$lib/APIClient";
import { UrlDependency } from "$lib/types/UrlDependency";
import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { browser } from "$app/environment";
import type { PageLoad } from "./$types";
import { takePendingConversation, type ConversationData } from "$lib/utils/pendingConversation";

export const load: PageLoad = async ({ params, depends, fetch, url }) => {
	depends(UrlDependency.Conversation);

	const client = useAPIClient({ fetch, origin: url.origin });

	// A conversation created by this tab hands its payload over via a one-shot
	// seed (see pendingConversation.ts), consumed here so the first load after
	// create skips the network round trip. Every other load, including every
	// invalidate() re-run, fetches fresh data.
	if (browser) {
		const seeded = takePendingConversation(params.id);
		if (seeded) {
			return seeded;
		}
	}

	try {
		return (await client
			.conversations({ id: params.id })
			.get()
			.then(handleResponse)) as ConversationData;
	} catch {
		redirect(302, `${base}/`);
	}
};
