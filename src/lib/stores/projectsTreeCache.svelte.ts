import { browser } from "$app/environment";
import type { ProjectView } from "$lib/types/Project";

/** One chat as the project folders list it. */
export interface ProjectConversation {
	id: string;
	title: string;
	model: string;
	updatedAt: string;
	/** The user typed this title: it is never regenerated. */
	titleByUser?: boolean;
}

/**
 * How long a read is trusted when the Chats sidebar is entered again: the
 * Agents panel's window. A returning visit draws the cached rows at once and
 * re-reads in place only when they are older than this.
 */
export const PROJECTS_CACHE_STALE_MS = 8_000;

/**
 * The sidebar's Projects tree, kept for the browser session
 * (stale-while-revalidate). The branch unmounts whenever the Agents view is
 * shown, and its rows used to be component state, so every return to Chats
 * began on a "Loading..." row and filled in again. Memory only, per user:
 * sign-out and an account switch drop it. Only the caller's own chats are ever
 * in it, because the endpoints it reads list nothing else.
 */
export const projectsTreeCache = $state<{
	projects: ProjectView[];
	loaded: boolean;
	failed: boolean;
	fetchedAt: number | undefined;
	/** Per project: its own chats, a count of other members' chats, and the
	 * time of the last good read. */
	chats: Record<string, ProjectConversation[]>;
	others: Record<string, number>;
	chatsFetchedAt: Record<string, number>;
	/** The open branch and folders, restored from storage once per page load. */
	open: boolean;
	expanded: Record<string, boolean>;
	restored: boolean;
	owner: string | null;
}>({
	projects: [],
	loaded: false,
	failed: false,
	fetchedAt: undefined,
	chats: {},
	others: {},
	chatsFetchedAt: {},
	open: false,
	expanded: {},
	restored: false,
	owner: null,
});

export function isProjectsFresh(now = Date.now()): boolean {
	return (
		projectsTreeCache.loaded &&
		!projectsTreeCache.failed &&
		projectsTreeCache.fetchedAt !== undefined &&
		now - projectsTreeCache.fetchedAt < PROJECTS_CACHE_STALE_MS
	);
}

export function areChatsFresh(projectId: string, now = Date.now()): boolean {
	const at = projectsTreeCache.chatsFetchedAt[projectId];
	return at !== undefined && now - at < PROJECTS_CACHE_STALE_MS;
}

/** Sign-out: forget every project and chat this tab learned. */
export function clearProjectsCache(): void {
	projectsTreeCache.projects = [];
	projectsTreeCache.loaded = false;
	projectsTreeCache.failed = false;
	projectsTreeCache.fetchedAt = undefined;
	projectsTreeCache.chats = {};
	projectsTreeCache.others = {};
	projectsTreeCache.chatsFetchedAt = {};
	projectsTreeCache.open = false;
	projectsTreeCache.expanded = {};
	projectsTreeCache.restored = false;
	projectsTreeCache.owner = null;
}

/** Tell the cache whose it is. A different user than the one it was filled
 * for empties it before anything can draw from it. */
export function bindProjectsCacheOwner(userId: string | null | undefined): void {
	// Never on the server: this module is shared by every request there.
	if (!browser || !userId) return;
	if (projectsTreeCache.owner && projectsTreeCache.owner !== userId) clearProjectsCache();
	projectsTreeCache.owner = userId;
}
