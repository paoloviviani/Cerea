/**
 * Whether web search is on for a turn.
 *
 * There is no per-chat or per-message switch: web search is on whenever the
 * administrator has enabled it (the turn still withholds the tool when no
 * search backend is granted). Two things can turn it off:
 *
 * - the user's own opt-out (`Settings.webSearchEnabled === false`), which wins;
 * - a project that explicitly sets its default to off (`Project.defaultWebSearch === false`).
 *
 * A settings document without the field (older accounts) counts as on.
 */
export function resolveWebSearchEnabled(options: {
	/** Project default (`Project.defaultWebSearch`). `undefined` means the project leaves it unset. */
	projectDefault?: boolean | null;
	/** User setting (`Settings.webSearchEnabled`). Absent means on. */
	settingsEnabled?: boolean | null;
}): boolean {
	if (options.settingsEnabled === false) return false;
	if (typeof options.projectDefault === "boolean") return options.projectDefault;
	return true;
}
