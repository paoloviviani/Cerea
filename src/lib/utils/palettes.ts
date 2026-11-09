/**
 * The colour palettes a person can choose in Settings → Appearance.
 *
 * Two independent choices, stored on the person's settings and applied as
 * `data-accent` / `data-neutral` / `data-sidebar` / `data-background` on `<html>` (the CSS is `src/styles/palettes.css`).
 * The defaults are the look the app has always had, and they are the
 * *absence* of an attribute — so a person who never opens the picker, and a
 * page rendered before their settings are known, is exactly the unthemed app.
 */

export const ACCENTS = ["blue", "violet", "teal", "green", "rose", "orange"] as const;
export const NEUTRALS = ["neutral", "cool", "warm"] as const;

/** The sidebar's surface: flat (today's look) or a distinct, tone-following one. */
export const SIDEBARS = ["flat", "contrast"] as const;
/** The decoration behind the main area, drawn from the accent. */
export const BACKGROUNDS = ["none", "dots", "glow", "bold"] as const;

export type Accent = (typeof ACCENTS)[number];
export type Neutral = (typeof NEUTRALS)[number];
export type Sidebar = (typeof SIDEBARS)[number];
export type Background = (typeof BACKGROUNDS)[number];

export const DEFAULT_ACCENT: Accent = "blue";
export const DEFAULT_NEUTRAL: Neutral = "neutral";
export const DEFAULT_SIDEBAR: Sidebar = "flat";
export const DEFAULT_BACKGROUND: Background = "none";

/**
 * Swatch colours for the picker: the accent's solid fill and the tone's
 * 500 step, dark enough to carry a white checkmark. Fixed, not read from the live theme — a swatch must show
 * what it *would* paint, not what is currently selected. (Keep in step with
 * `--colour-accent-solid` and `--color-gray-500` in palettes.css; the test checks.)
 */
export const ACCENT_SWATCHES: Record<Accent, string> = {
	blue: "#2563eb",
	violet: "#7f22fe",
	teal: "#00786f",
	green: "#008236",
	rose: "#ec003f",
	orange: "#ca3500",
};

export const NEUTRAL_SWATCHES: Record<Neutral, string> = {
	neutral: "#737373",
	cool: "#6c747e",
	warm: "#78726c",
};

/** An unknown or missing value is "not chosen", never an error: settings written by a newer build must not break an older one. */
export function parseAccent(value: unknown): Accent | undefined {
	return ACCENTS.find((a) => a === value);
}

/**
 * The tones' earlier names. A choice saved as "gray", "slate" or "stone" (in
 * Mongo, in a client's cached settings) means the tone that replaced it, so it
 * is translated wherever a tone is read; nothing is migrated in the database.
 */
export const LEGACY_NEUTRALS: Record<string, Neutral> = {
	gray: "neutral",
	slate: "cool",
	stone: "warm",
};

/** An old tone id becomes its replacement; anything else passes through untouched. */
export function migrateNeutral(value: unknown): unknown {
	return typeof value === "string" && Object.hasOwn(LEGACY_NEUTRALS, value)
		? LEGACY_NEUTRALS[value]
		: value;
}

export function parseNeutral(value: unknown): Neutral | undefined {
	const current = migrateNeutral(value);
	return NEUTRALS.find((n) => n === current);
}

export function parseSidebar(value: unknown): Sidebar | undefined {
	return SIDEBARS.find((v) => v === value);
}

export function parseBackground(value: unknown): Background | undefined {
	// "mesh" was Glow's name on test builds before 0.48.0; read it as Glow.
	if (value === "mesh") return "glow";
	return BACKGROUNDS.find((v) => v === value);
}

type PaletteChoice = {
	accent?: unknown;
	neutral?: unknown;
	sidebar?: unknown;
	background?: unknown;
};

/** The attributes for `<html>`: nothing at all for the defaults. */
export function paletteAttributes(settings: PaletteChoice): string {
	const accent = parseAccent(settings.accent);
	const neutral = parseNeutral(settings.neutral);
	const sidebar = parseSidebar(settings.sidebar);
	const background = parseBackground(settings.background);
	return [
		accent && accent !== DEFAULT_ACCENT ? `data-accent="${accent}"` : "",
		neutral && neutral !== DEFAULT_NEUTRAL ? `data-neutral="${neutral}"` : "",
		sidebar && sidebar !== DEFAULT_SIDEBAR ? `data-sidebar="${sidebar}"` : "",
		background && background !== DEFAULT_BACKGROUND ? `data-background="${background}"` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** The same choice applied live, from the picker. */
export function applyPalette(root: HTMLElement, choice: PaletteChoice) {
	const set = (name: string, value: string | undefined, fallback: string) => {
		if (value && value !== fallback) root.setAttribute(name, value);
		else root.removeAttribute(name);
	};
	set("data-accent", parseAccent(choice.accent), DEFAULT_ACCENT);
	set("data-neutral", parseNeutral(choice.neutral), DEFAULT_NEUTRAL);
	set("data-sidebar", parseSidebar(choice.sidebar), DEFAULT_SIDEBAR);
	set("data-background", parseBackground(choice.background), DEFAULT_BACKGROUND);
}
