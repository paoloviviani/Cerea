import type { ConvSidebar } from "$lib/types/ConvSidebar";
import type { CodeAgentSession, CodeTurnState } from "$lib/types/CodeAgent";

/** How far back the sidebar's Recent list reaches, ending now. */
export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** A quiet couple of days never leaves the list nearly empty: it is filled to
 * this many rows with older items. */
export const RECENT_MIN_ITEMS = 10;

export interface RecentChat {
	kind: "chat";
	id: string;
	title: string;
	activityAt: number;
	project?: { id: string; name: string };
	unread?: boolean;
}

export interface RecentAgent {
	kind: "agent";
	id: string;
	title: string;
	activityAt: number;
	workspaceId: string;
	machine: { id: string; name: string; online: boolean };
	state: CodeTurnState;
}

export type RecentItem = RecentChat | RecentAgent;

export interface RecentMachine {
	id: string;
	name: string;
	online: boolean;
	agents: CodeAgentSession[];
}

const time = (value: Date | string | undefined | null): number => {
	const t = value ? new Date(value).getTime() : NaN;
	return Number.isFinite(t) ? t : 0;
};

/**
 * One list, newest first, of the chats (project chats included) and the
 * coding-agent sessions that were active in the last `RECENT_WINDOW_MS`, topped
 * up to `RECENT_MIN_ITEMS` with older ones.
 *
 * A chat's moment is `lastActivityAt` (what the user last really did in it),
 * falling back to `updatedAt` only for a row that has none. A session's is its
 * `updatedAt` as the machine reports it: the daemon moves it on every message
 * and turn, and nothing else on the session is a better clock. Subagents are
 * left out, as in the Agents tree.
 *
 * `chatsComplete` says the chats given are all of them. When more pages exist,
 * a session older than the oldest chat loaded is held back until that page
 * arrives, so the order never has to be corrected afterwards.
 */
export function buildRecent(input: {
	chats: ConvSidebar[];
	chatsComplete: boolean;
	projects: Record<string, string>;
	machines: RecentMachine[];
	now?: number;
	windowMs?: number;
	minItems?: number;
}): RecentItem[] {
	const now = input.now ?? Date.now();
	const windowMs = input.windowMs ?? RECENT_WINDOW_MS;
	const minItems = input.minItems ?? RECENT_MIN_ITEMS;

	const items: RecentItem[] = input.chats.map((chat) => ({
		kind: "chat",
		id: String(chat.id),
		title: chat.title,
		activityAt: time(chat.lastActivityAt) || time(chat.updatedAt),
		...(chat.projectId
			? { project: { id: chat.projectId, name: input.projects[chat.projectId] ?? "" } }
			: {}),
		...(chat.unread ? { unread: true } : {}),
	}));
	const loadedFloor =
		input.chatsComplete || items.length === 0
			? 0
			: Math.min(...items.map((item) => item.activityAt));
	for (const machine of input.machines) {
		for (const agent of machine.agents) {
			if (agent.parentId) continue;
			const activityAt = time(agent.updatedAt);
			if (activityAt < loadedFloor) continue;
			items.push({
				kind: "agent",
				id: agent.id,
				title: agent.title,
				activityAt,
				workspaceId: agent.workspaceId,
				machine: { id: machine.id, name: machine.name, online: machine.online },
				state: agent.state,
			});
		}
	}
	items.sort((a, b) => b.activityAt - a.activityAt);
	const inWindow = items.filter((item) => now - item.activityAt <= windowMs).length;
	return items.slice(0, Math.max(inWindow, Math.min(minItems, items.length)));
}
