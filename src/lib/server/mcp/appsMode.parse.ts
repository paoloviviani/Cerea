/** The pure part of `appsMode.ts`: the three values and how a setting is read. */
export const APPS_MODES = ["off", "deployment", "all"] as const;
export type AppsMode = (typeof APPS_MODES)[number];

export function parseAppsMode(value: string | undefined | null): AppsMode {
	const word = (value ?? "").trim().toLowerCase();
	if (word === "") return "all";
	return (APPS_MODES as readonly string[]).includes(word) ? (word as AppsMode) : "off";
}
