/**
 * Archiving and unarchiving a conversation, from any surface.
 *
 * One function pair for the sidebar's `⋯`, the /chats rows and the Archived
 * tab, so each updates the same things afterwards: the sidebar's flat list, the
 * Projects tree (an archived project chat leaves its project) and a toast. The
 * rules are the server's (`PATCH /api/v2/conversations/[id]`, `{ archived }`).
 * There is no undo toast: the Archived tab is the way back.
 *
 * Call it during component initialisation: it reads two stores from context.
 */

import { base } from "$app/paths";
import { m } from "$lib/paraglide/messages";
import { useConversationsStore } from "$lib/stores/conversations.svelte";
import { useNotificationsStore } from "$lib/stores/notifications.svelte";
import { projectsChanged } from "$lib/stores/projectsRevision";

export function useArchiveConversation() {
	const convs = useConversationsStore();
	const toasts = useNotificationsStore();

	async function send(
		id: string,
		archived: boolean,
		failed: string
	): Promise<{ leftProject: boolean } | null> {
		try {
			const response = await fetch(`${base}/api/v2/conversations/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ archived }),
			});
			if (!response.ok) throw new Error(failed);
			// superjson wraps the body: `{ json: {...} }`.
			const body = (await response.json().catch(() => ({}))) as {
				json?: { leftProject?: boolean };
				leftProject?: boolean;
			};
			return { leftProject: (body.json ?? body).leftProject === true };
		} catch {
			toasts?.pushMessage(failed, "error");
			return null;
		}
	}

	return {
		/** @returns whether the chat was archived */
		async archive(id: string): Promise<boolean> {
			const result = await send(id, true, m["chat.archive.failed"]());
			if (!result) return false;
			convs?.remove(id);
			if (result.leftProject) projectsChanged();
			toasts?.pushMessage(
				result.leftProject
					? m["chat.archive.archived_left_project"]()
					: m["chat.archive.archived"]()
			);
			return true;
		},
		/** @returns whether the chat was unarchived */
		async unarchive(id: string): Promise<boolean> {
			const result = await send(id, false, m["chat.archive.unarchive_failed"]());
			if (!result) return false;
			// It rejoins the sidebar's list at its place by recent activity.
			await convs?.refresh();
			toasts?.pushMessage(m["chat.archive.unarchived"]());
			return true;
		},
	};
}
