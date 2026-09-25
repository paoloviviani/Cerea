/**
 * The /code explorer's pure parts: git decorations for the tree (a file's
 * own letter, rolled up to every folder above it) and human sizes.
 */

export type GitBadge = "M" | "A" | "D" | "R" | "U" | "?";

/** Which letter wins when several changes sit under one folder. */
const BADGE_WEIGHT: Record<GitBadge, number> = { U: 6, D: 5, M: 4, R: 3, A: 2, "?": 1 };

/** One porcelain-v2 X/Y pair → the badge the tree shows. */
export function badgeOf(x: string, y: string): GitBadge | null {
	if (x === "?" || y === "?") return "?";
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "U";
	for (const code of [x, y]) {
		if (code === "D") return "D";
	}
	for (const code of [x, y]) {
		if (code === "R" || code === "C") return "R";
	}
	for (const code of [x, y]) {
		if (code === "A") return "A";
	}
	for (const code of [x, y]) {
		if (code === "M" || code === "T") return "M";
	}
	return null;
}

/**
 * path → badge for every changed file, and for every folder above one: the
 * strongest letter among what it holds.
 */
export function gitBadges(
	entries: Array<{ path: string; x: string; y: string }>
): Map<string, GitBadge> {
	const out = new Map<string, GitBadge>();
	const put = (path: string, badge: GitBadge) => {
		const prev = out.get(path);
		if (!prev || BADGE_WEIGHT[badge] > BADGE_WEIGHT[prev]) out.set(path, badge);
	};
	for (const e of entries) {
		const badge = badgeOf(e.x, e.y);
		if (!badge) continue;
		put(e.path, badge);
		const parts = e.path.split("/");
		for (let i = parts.length - 1; i > 0; i -= 1) put(parts.slice(0, i).join("/"), badge);
	}
	return out;
}

export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
