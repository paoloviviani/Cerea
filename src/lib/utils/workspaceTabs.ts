/**
 * The Workspace page had eight tabs and has six: Local connectors became the
 * "On your machines" section of Connectors, and Custom models the "Your custom
 * models" section of Models. The old addresses keep working: `workspaceRedirect`
 * maps one to its new home, and the page's server load redirects there.
 */
export const ON_YOUR_MACHINES_ID = "on-your-machines";
export const CUSTOM_MODELS_ID = "custom-models";

/**
 * Where an old workspace address now lives, as a path-and-query (and hash) to put
 * after `/workspace`, or null when the address is current. Other query parameters
 * ride along; a custom model's `id` becomes `custom` (the Models tab's own `id`
 * opens a catalogue model).
 */
export function workspaceRedirect(url: URL): string | null {
	const tab = url.searchParams.get("tab");
	if (tab !== "local" && tab !== "custom") return null;
	const params = new URLSearchParams(url.searchParams);
	if (tab === "local") {
		params.set("tab", "mcp");
		params.delete("id");
		return `?${params}#${ON_YOUR_MACHINES_ID}`;
	}
	params.set("tab", "models");
	const id = params.get("id");
	params.delete("id");
	if (id) params.set("custom", id);
	return `?${params}#${CUSTOM_MODELS_ID}`;
}
