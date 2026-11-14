/**
 * What a session is called where its title is shown. opencode 2 leaves a new
 * session without a title until its title agent has run, and galopin lends it
 * the first words of its first prompt; this is the last resort for a session
 * that has neither (never prompted, or an older galopin): the folder's last
 * segment, never the whole path, else the generic label.
 */
export function folderName(path: string | null | undefined): string {
	const parts = (path ?? "").split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : "";
}

export function agentDisplayTitle(
	title: string | null | undefined,
	workspace: { name?: string | null; path?: string | null } | null | undefined,
	generic: string
): string {
	const t = (title ?? "").trim();
	if (t) return t;
	// A workspace made before the name defaulted to the last segment carries the path.
	const name = workspace?.name ?? "";
	const named = /[\\/]/.test(name) ? folderName(name) : name;
	return named || folderName(workspace?.path) || generic;
}
