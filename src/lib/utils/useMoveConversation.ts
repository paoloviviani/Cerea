/**
 * Moving a conversation into, between and out of projects, from any surface.
 *
 * One function for the menu, the picker and the drag, so each of them updates
 * the same things afterwards: the sidebar's flat list (a project chat is left
 * out of it), the Projects tree (`projectsChanged`) and a toast. The rules
 * themselves are the server's (`PATCH /api/v2/conversations/[id]`).
 *
 * Call it during component initialisation: it reads two stores from context.
 */

import { base } from "$app/paths";
import { useConversationsStore } from "$lib/stores/conversations.svelte";
import { useNotificationsStore } from "$lib/stores/notifications.svelte";
import { projectsChanged } from "$lib/stores/projectsRevision";

export interface MovableChat {
	id: string;
	title: string;
	model?: string;
	updatedAt?: Date | string;
}

export interface MoveTarget {
	id: string;
	name: string;
}

export function useMoveConversation() {
	const convs = useConversationsStore();
	const toasts = useNotificationsStore();

	/**
	 * @param to the project to move into, or null to take the chat out
	 * @param fromName the project it leaves, for the "Removed from" toast
	 * @returns whether the move happened
	 */
	return async function move(
		chat: MovableChat,
		to: MoveTarget | null,
		fromName?: string
	): Promise<boolean> {
		try {
			const response = await fetch(`${base}/api/v2/conversations/${chat.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId: to ? to.id : null }),
			});
			if (!response.ok) {
				let message = "Could not move the chat.";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// An HTML error page says the same thing less usefully.
				}
				throw new Error(message);
			}
		} catch (err) {
			toasts?.pushMessage(err instanceof Error ? err.message : "Could not move the chat.", "error");
			return false;
		}

		if (convs) {
			const listed = convs.list.some((entry) => String(entry.id) === chat.id);
			if (listed) {
				convs.setProject(chat.id, to?.id);
			} else if (!to) {
				convs.prepend({
					id: chat.id,
					title: chat.title,
					model: chat.model,
					updatedAt: chat.updatedAt ? new Date(chat.updatedAt) : new Date(),
				});
			}
		}
		projectsChanged();
		toasts?.pushMessage(to ? `Moved to ${to.name}` : `Removed from ${fromName ?? "the project"}`);
		return true;
	};
}
