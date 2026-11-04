/**
 * Which parts of the sidebar's Projects tree are open, remembered per browser
 * across remounts and reloads. The chat sidebar is unmounted whenever the
 * Agents view is shown, so state kept in the component alone collapsed every
 * project on the way back to Chats. Mirrors `codeTreeCollapse.ts` for the
 * agents tree; here the default is closed, so only what is open is stored.
 */

export const PROJECTS_TREE_OPEN_KEY = "nav.projects.open";

export interface ProjectsTreeOpen {
	/** The Projects branch itself. */
	branch: boolean;
	/** Ids of the project folders that are open. */
	projects: string[];
}

const CLOSED: ProjectsTreeOpen = { branch: false, projects: [] };

/** Corrupt or foreign JSON reads as everything closed, never a thrown render. */
export function readProjectsTreeOpen(
	storage: Pick<Storage, "getItem"> | undefined
): ProjectsTreeOpen {
	let raw: string | null | undefined;
	try {
		raw = storage?.getItem(PROJECTS_TREE_OPEN_KEY);
	} catch {
		return CLOSED;
	}
	if (!raw) return CLOSED;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return CLOSED;
		const { branch, projects } = parsed as Record<string, unknown>;
		return {
			branch: branch === true,
			projects: Array.isArray(projects)
				? projects.filter((id): id is string => typeof id === "string")
				: [],
		};
	} catch {
		return CLOSED;
	}
}

export function writeProjectsTreeOpen(
	storage: Pick<Storage, "setItem"> | undefined,
	state: ProjectsTreeOpen
): void {
	try {
		storage?.setItem(PROJECTS_TREE_OPEN_KEY, JSON.stringify(state));
	} catch {
		// Storage full or blocked (a private window): the tree still works, it
		// just forgets on the next remount.
	}
}
