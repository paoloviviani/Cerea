/**
 * The colour palettes a person can choose in Settings → Appearance.
 *
 * Two independent choices, stored on the person's settings and applied as
 * `data-accent` / `data-neutral` on `<html>` (the CSS is `src/styles/palettes.css`).
 * The defaults are the look the app has always had, and they are the
 * *absence* of an attribute — so a person who never opens the picker, and a
 * page rendered before their settings are known, is exactly the unthemed app.
 */

export const ACCENTS = ["blue", "violet", "teal", "green", "rose", "orange"] as const;
export const NEUTRALS = ["gray", "slate", "stone"] as const;

export type Accent = (typeof ACCENTS)[number];
export type Neutral = (typeof NEUTRALS)[number];

export const DEFAULT_ACCENT: Accent = "blue";
export const DEFAULT_NEUTRAL: Neutral = "gray";

export const ACCENT_LABELS: Record<Accent, string> = {
	blue: "Blue",
	violet: "Violet",
	teal: "Teal",
	green: "Green",
	rose: "Rose",
	orange: "Orange",
};

export const NEUTRAL_LABELS: Record<Neutral, string> = {
	gray: "Gray",
	slate: "Slate",
	stone: "Stone",
};

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
	gray: "#737373",
	slate: "#62748e",
	stone: "#79716b",
};

/** An unknown or missing value is "not chosen", never an error: settings written by a newer build must not break an older one. */
export function parseAccent(value: unknown): Accent | undefined {
	return ACCENTS.find((a) => a === value);
}

export function parseNeutral(value: unknown): Neutral | undefined {
	return NEUTRALS.find((n) => n === value);
}

/** The attributes for `<html>`: nothing at all for the defaults. */
export function paletteAttributes(settings: { accent?: unknown; neutral?: unknown }): string {
	const accent = parseAccent(settings.accent);
	const neutral = parseNeutral(settings.neutral);
	return [
		accent && accent !== DEFAULT_ACCENT ? `data-accent="${accent}"` : "",
		neutral && neutral !== DEFAULT_NEUTRAL ? `data-neutral="${neutral}"` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** The same choice applied live, from the picker. */
export function applyPalette(
	root: HTMLElement,
	{ accent, neutral }: { accent?: unknown; neutral?: unknown }
) {
	const a = parseAccent(accent);
	const n = parseNeutral(neutral);
	if (a && a !== DEFAULT_ACCENT) root.setAttribute("data-accent", a);
	else root.removeAttribute("data-accent");
	if (n && n !== DEFAULT_NEUTRAL) root.setAttribute("data-neutral", n);
	else root.removeAttribute("data-neutral");
}
