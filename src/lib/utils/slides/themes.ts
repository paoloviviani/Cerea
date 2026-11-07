/**
 * Slide look (ADR 0111). A deck has no theme unless it asks for one: the
 * model designs freely, and Cerea only supplies brand variables
 * (`--brand-accent`, `--brand-font`, `--brand-logo-url`) from the
 * organisation default or the deck's front matter. Optional themes (two
 * Cerea ones and six of reveal.js's) are applied only when named.
 * Everything resolved here is a validated value in a fixed declaration.
 */

export const CEREA_THEME_IDS = ["cerea", "cerea-dark"] as const;
/** reveal.js's own themes, with their web-font imports removed (see srcdoc.ts) */
export const BUILTIN_THEME_IDS = [
	"white",
	"black",
	"simple",
	"moon",
	"solarized",
	"dracula",
] as const;
export const THEME_IDS = [...CEREA_THEME_IDS, ...BUILTIN_THEME_IDS] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export function isBuiltinTheme(id: ThemeId): boolean {
	return (BUILTIN_THEME_IDS as readonly string[]).includes(id);
}

/** Themes drawn dark, for the colour-scheme hint */
const DARK_BUILTINS: readonly string[] = ["black", "moon", "dracula"];

export interface CereaPreset {
	id: (typeof CEREA_THEME_IDS)[number];
	background: string;
	main: string;
	heading: string;
	muted: string;
	accent: string;
	/** Panel tint: code blocks, quotes, columns */
	surface: string;
	dark: boolean;
}

export const CEREA_PRESETS: Record<(typeof CEREA_THEME_IDS)[number], CereaPreset> = {
	cerea: {
		id: "cerea",
		background: "#ffffff",
		main: "#1f2937",
		heading: "#111827",
		muted: "#6b7280",
		accent: "#7008e7",
		surface: "#f3f4f6",
		dark: false,
	},
	"cerea-dark": {
		id: "cerea-dark",
		background: "#111827",
		main: "#e5e7eb",
		heading: "#ffffff",
		muted: "#9ca3af",
		accent: "#a78bfa",
		surface: "#1f2937",
		dark: true,
	},
};

/** System font stacks only: the preview sandbox allows no remote fonts. */
export const FONT_IDS = ["sans", "serif", "humanist", "mono"] as const;
export type FontId = (typeof FONT_IDS)[number];
export const DEFAULT_FONT: FontId = "sans";

export const FONT_STACKS: Record<FontId, string> = {
	sans: 'Inter, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
	serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, "Times New Roman", serif',
	humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", Verdana, sans-serif',
	mono: 'ui-monospace, "SF Mono", "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace',
};

const MONO_STACK = FONT_STACKS.mono;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A `#rrggbb` colour from `#abc`, `abc` or `#aabbcc`; undefined for anything else. */
export function sanitizeAccent(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = HEX.exec(value.trim());
	if (!match) return undefined;
	let hex = match[1].toLowerCase();
	if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
	return `#${hex}`;
}

export function sanitizeTheme(value: unknown): ThemeId | undefined {
	if (typeof value !== "string") return undefined;
	const id = value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	return (THEME_IDS as readonly string[]).includes(id) ? (id as ThemeId) : undefined;
}

export function sanitizeFont(value: unknown): FontId | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim().toLowerCase();
	return (FONT_IDS as readonly string[]).includes(id) ? (id as FontId) : undefined;
}

/** Largest inline logo accepted (characters of the data URL). */
export const MAX_LOGO_DATA_URL = 400_000;
const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i;
const LOGO_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,98}\.(?:png|jpe?g|svg|webp|gif)$/iu;

/** A logo reference: a bundled image data URL, or a file name to look up in the chat. */
export function sanitizeLogo(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim();
	if (v.length > MAX_LOGO_DATA_URL) return undefined;
	if (LOGO_DATA_URL.test(v)) return v;
	return LOGO_NAME.test(v) ? v : undefined;
}

/** The organisation's default look (admin settings); every field optional. */
export interface OrgSlideDefaults {
	accent?: string;
	font?: FontId;
	/** A data: URL (the admin uploads an image) */
	logo?: string;
}

export function sanitizeOrgDefaults(value: unknown): OrgSlideDefaults {
	if (!value || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const out: OrgSlideDefaults = {};
	const accent = sanitizeAccent(raw.accent);
	if (accent) out.accent = accent;
	const font = sanitizeFont(raw.font);
	if (font) out.font = font;
	const logo =
		typeof raw.logo === "string" &&
		LOGO_DATA_URL.test(raw.logo.trim()) &&
		raw.logo.length <= MAX_LOGO_DATA_URL
			? raw.logo.trim()
			: undefined;
	if (logo) out.logo = logo;
	return out;
}

export interface DeckLook {
	theme?: ThemeId;
	accent?: string;
	font?: FontId;
	logo?: string;
}

export interface ResolvedTheme {
	/** Only when the deck named one */
	theme?: ThemeId;
	accent: string;
	font: FontId;
	/** A data: URL once resolved; a bare file name is dropped by the caller if it cannot be found */
	logo?: string;
	/** `:root { ... }` declarations that go after the theme's own CSS */
	css: string;
}

/** The brand accent when neither the deck nor the organisation set one. */
export const DEFAULT_ACCENT = "#7008e7";

/** Pick the text colour that reads on a given accent. */
function onColour(hex: string, light: string, dark: string): string {
	const n = parseInt(hex.slice(1), 16);
	const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	const l = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
	return l > 0.4 ? dark : light;
}

/**
 * Deck knobs win over the organisation default. The brand variables are
 * always defined; a theme's variables only when the deck named a theme. A
 * logo reference that is only a file name needs the caller to swap in a data
 * URL (`logo` stays the name until then).
 */
export function resolveTheme(deck: DeckLook = {}, org: OrgSlideDefaults = {}): ResolvedTheme {
	const theme = deck.theme;
	const accent = deck.accent ?? org.accent ?? DEFAULT_ACCENT;
	const font = deck.font ?? org.font ?? DEFAULT_FONT;
	const logo = deck.logo ?? org.logo;
	const onAccent = onColour(accent, "#ffffff", "#111111");
	const d: string[] = [
		`--brand-accent:${accent};`,
		`--brand-on-accent:${onAccent};`,
		`--brand-font:${FONT_STACKS[font]};`,
	];
	if (logo?.startsWith("data:")) d.push(`--brand-logo-url:url("${logo}");`);
	if (theme) {
		const explicit = deck.accent ?? org.accent;
		if (isBuiltinTheme(theme)) {
			d.push(
				`--cerea-accent:${explicit ?? "var(--r-link-color)"};`,
				"--cerea-muted:color-mix(in srgb,var(--r-main-color) 60%,var(--r-background-color));",
				"--cerea-surface:color-mix(in srgb,var(--r-main-color) 10%,var(--r-background-color));",
				`color-scheme:${DARK_BUILTINS.includes(theme) ? "dark" : "light"};`
			);
		} else {
			const p = CEREA_PRESETS[theme as (typeof CEREA_THEME_IDS)[number]];
			const f = deck.font ?? org.font ?? DEFAULT_FONT;
			d.push(
				`--r-background-color:${p.background};`,
				`--r-main-color:${p.main};`,
				`--r-heading-color:${p.heading};`,
				`--r-code-font:${MONO_STACK};`,
				`--r-main-font:${FONT_STACKS[f]};`,
				`--r-heading-font:${FONT_STACKS[f]};`,
				`--cerea-accent:${explicit ?? p.accent};`,
				`--cerea-muted:${p.muted};`,
				`--cerea-surface:${p.surface};`,
				`color-scheme:${p.dark ? "dark" : "light"};`
			);
			d.push(
				`--r-link-color:${explicit ?? p.accent};`,
				`--r-link-color-hover:${explicit ?? p.accent};`
			);
		}
		if (explicit) {
			d.push(
				`--r-link-color:${explicit};`,
				`--r-link-color-hover:${explicit};`,
				`--r-selection-background-color:${explicit};`,
				`--r-selection-color:${onAccent};`
			);
		}
		if ((deck.font ?? org.font) && isBuiltinTheme(theme)) {
			const f = (deck.font ?? org.font) as FontId;
			d.push(`--r-main-font:${FONT_STACKS[f]};`, `--r-heading-font:${FONT_STACKS[f]};`);
		}
	}
	return { theme, accent, font, logo, css: `:root{${d.join("")}}` };
}
