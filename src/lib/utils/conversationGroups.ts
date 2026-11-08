import type { ConvSidebar } from "$lib/types/ConvSidebar";

export type ConversationGroup = "today" | "week" | "month" | "older";

/** The instant a chat is filed under: its last real activity, else its last write. */
export function activityTime(conv: Pick<ConvSidebar, "updatedAt" | "lastActivityAt">): number {
	return (conv.lastActivityAt ?? conv.updatedAt).getTime();
}

/**
 * Splits chats by calendar day in the browser's local time. "Today" is since
 * local midnight, "week" the seven calendar days before today, "month" back to
 * the same calendar day a month earlier, and "older" the rest. `now` is a
 * parameter so a test can fix it.
 */
export function groupConversations<T extends Pick<ConvSidebar, "updatedAt" | "lastActivityAt">>(
	convs: T[],
	now: Date = new Date()
): Record<ConversationGroup, T[]> {
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
	const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).getTime();
	const today = startOfToday.getTime();
	const groups: Record<ConversationGroup, T[]> = { today: [], week: [], month: [], older: [] };
	for (const conv of convs) {
		const at = activityTime(conv);
		if (at >= today) groups.today.push(conv);
		else if (at >= weekStart) groups.week.push(conv);
		else if (at >= monthStart) groups.month.push(conv);
		else groups.older.push(conv);
	}
	return groups;
}
