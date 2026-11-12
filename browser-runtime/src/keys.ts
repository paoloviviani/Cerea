/** Key names as the page sees them, so a rule cannot be dodged by another spelling of Enter. */

const MODIFIERS = new Set(["control", "ctrl", "shift", "alt", "meta", "command", "cmd", "controlormeta", "altgraph"]);

export interface ParsedKey {
	/** Canonical name: NumpadEnter and Return are Enter; " " and Spacebar are Space. */
	base: string;
	/** Modifier names that came with it (normalised to Playwright's spelling is not needed). */
	modifiers: string[];
}

export function parseKey(key: string): ParsedKey {
	if (key === " ") return { base: "Space", modifiers: [] };
	// "Control++" is Control and "+"; split on a plus that has something after it.
	const parts = key.endsWith("+") && key.length > 1 ? [...key.slice(0, -2).split("+").filter(Boolean), "+"] : key.split("+");
	const base = parts.pop() ?? "";
	const modifiers = parts.filter((p) => MODIFIERS.has(p.toLowerCase()));
	const lower = base.toLowerCase();
	let name = base;
	if (lower === "numpadenter" || lower === "return" || lower === "enter") name = "Enter";
	else if (lower === "space" || lower === "spacebar" || base === " ") name = "Space";
	return { base: name, modifiers };
}

/** The spelling Playwright accepts for a key as sent. */
export function playwrightKey(key: string): string {
	return key === " " ? "Space" : key.replace(/\+ $/, "+Space").replace(/^ $/, "Space");
}
