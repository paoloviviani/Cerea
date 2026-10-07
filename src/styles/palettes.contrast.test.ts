import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, ACCENT_SWATCHES, NEUTRALS, NEUTRAL_SWATCHES } from "../lib/utils/palettes";

/*
 * The palettes' contrast floor, measured from the shipped CSS rather than from
 * a copy of its numbers: `tokens.css` and `main.css` for today's look,
 * `palettes.css` for everything a person can pick, applied in the order the
 * cascade would. If a hand edit (or a regenerate) drops any pair under WCAG
 * AA's 4.5:1, this names the accent, tone, theme and pair.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Vars = Record<string, string>;

/** `selector { --a: #fff; … }` → declarations, keyed by the selector as written. */
function rules(css: string): Map<string, Vars> {
	const out = new Map<string, Vars>();
	for (const [, selector, body] of strip(css).matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
		const sel = selector.trim();
		const vars: Vars = out.get(sel) ?? {};
		for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
			vars[name] = value.trim();
		}
		out.set(sel, vars);
	}
	return out;
}

const tokens = rules(read("./tokens.css"));
const palettes = rules(read("./palettes.css"));
const mainCss = strip(read("./main.css"));

/** The app's own gray ramp: the `@theme { --color-gray-* }` block in main.css. */
const defaultGray: Vars = Object.fromEntries(
	[...mainCss.matchAll(/(--color-gray-\d+):\s*(#[0-9a-f]{6})/gi)].map(([, k, v]) => [k, v])
);

/** Tailwind's blue, as the default accent's scale; oklch → sRGB hex like the generator does. */
function oklchToHex(css: string): string {
	const m = css.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
	if (!m) throw new Error(`not oklch: ${css}`);
	const L = parseFloat(m[1]) / 100;
	const a = parseFloat(m[2]) * Math.cos((parseFloat(m[3]) * Math.PI) / 180);
	const b = parseFloat(m[2]) * Math.sin((parseFloat(m[3]) * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
	];
	return (
		"#" +
		lin
			.map((v) => {
				const c = Math.min(1, Math.max(0, v));
				const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
				return Math.round(g * 255)
					.toString(16)
					.padStart(2, "0");
			})
			.join("")
	);
}
const twTheme = readFileSync(
	new URL("../../node_modules/tailwindcss/theme.css", import.meta.url),
	"utf8"
);
const defaultBlue: Vars = Object.fromEntries(
	[...twTheme.matchAll(/(--color-blue-\d+):\s*([^;]+);/g)].map(([, k, v]) => [k, oklchToHex(v)])
);

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** What `<html class="dark"? data-accent data-neutral>` resolves every variable to. */
function resolve(accent: string, neutral: string, dark: boolean): Vars {
	const vars: Vars = { ...defaultGray, ...defaultBlue, ...tokens.get(":root") };
	if (dark) Object.assign(vars, tokens.get(".dark"));
	const layers = [`:root[data-neutral="${neutral}"]`, `:root[data-accent="${accent}"]`];
	if (dark)
		layers.push(`:root.dark[data-neutral="${neutral}"]`, `:root.dark[data-accent="${accent}"]`);
	// Neutral and accent set disjoint variables, so their order between each other is moot;
	// the dark rules over the light ones is the cascade's (0,3,0) over (0,2,0).
	// Gray and blue are the defaults: no attribute, so no rule, so nothing to apply.
	for (const selector of layers) Object.assign(vars, palettes.get(selector));
	return vars;
}

const hexOf = (vars: Vars, name: string): string => {
	let value = vars[name];
	const seen = new Set<string>();
	while (value?.startsWith("var(")) {
		const ref = value.slice(4, -1).trim();
		if (seen.has(ref)) break;
		seen.add(ref);
		value = vars[ref];
	}
	if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
		throw new Error(`${name} did not resolve to a hex colour (got ${value})`);
	}
	return value;
};

const WHITE = "#ffffff";
const FLOOR = 4.5;

interface Pair {
	name: string;
	fg: string;
	bg: string;
}

function pairs(accent: string, neutral: string, dark: boolean): Pair[] {
	const v = resolve(accent, neutral, dark);
	const c = (name: string) => hexOf(v, name);
	const list: Pair[] = [
		// The composer's send button and every `bg-accent-solid` fill: white text on it.
		{ name: "send button (white on accent-solid)", fg: WHITE, bg: c("--colour-accent-solid") },
		{ name: "send button hover", fg: WHITE, bg: c("--colour-accent-solid-hover") },
		// `bg-blue-600 text-white` and its hover, spelled as Tailwind utilities in ~50 places.
		{ name: "primary button bg-blue-600", fg: WHITE, bg: c("--color-blue-600") },
		{ name: "primary button hover:bg-blue-700", fg: WHITE, bg: c("--color-blue-700") },
		// Accent text: links, and the selected sidebar row (`bg-accent-subtle text-accent`).
		{ name: "accent text on page", fg: c("--colour-accent"), bg: c("--colour-bg") },
		{ name: "accent text on surface", fg: c("--colour-accent"), bg: c("--colour-surface") },
		{ name: "accent text on raised", fg: c("--colour-accent"), bg: c("--colour-surface-raised") },
		{
			name: "selected sidebar row (accent on accent-subtle)",
			fg: c("--colour-accent"),
			bg: c("--colour-accent-subtle"),
		},
		{
			name: "accent hover on page",
			fg: c("--colour-accent-hover"),
			bg: c("--colour-bg"),
		},
		// Ink on the grounds, so a tone cannot quietly cost the page its legibility.
		...(["--colour-text", "--colour-text-muted", "--colour-text-faint"] as const).flatMap((ink) =>
			(["--colour-bg", "--colour-surface"] as const).map((ground) => ({
				name: `${ink.slice(2)} on ${ground.slice(2)}`,
				fg: c(ink),
				bg: c(ground),
			}))
		),
	];
	if (dark) {
		list.push(
			{
				name: "user bubble (dark:text-gray-100 on dark:bg-accent-subtle)",
				fg: c("--color-gray-100"),
				bg: c("--colour-accent-subtle"),
			},
			// `text-blue-400` / `text-blue-300`, the dark-mode spelling of a link.
			{ name: "text-blue-400 on surface", fg: c("--color-blue-400"), bg: c("--colour-surface") },
			{ name: "text-blue-300 on surface", fg: c("--color-blue-300"), bg: c("--colour-surface") }
		);
	} else {
		list.push(
			{
				name: "user bubble (text-gray-800 on bg-blue-50)",
				fg: c("--color-gray-800"),
				bg: c("--color-blue-50"),
			},
			{ name: "text-blue-600 on white", fg: c("--color-blue-600"), bg: WHITE },
			{ name: "text-blue-700 on bg-blue-50", fg: c("--color-blue-700"), bg: c("--color-blue-50") }
		);
	}
	return list;
}

const accents = ["blue", ...ACCENTS.filter((a) => a !== "blue")];
const neutrals = ["gray", ...NEUTRALS.filter((n) => n !== "gray")];

describe("palette contrast (WCAG AA, 4.5:1)", () => {
	for (const accent of accents) {
		for (const neutral of neutrals) {
			for (const dark of [false, true]) {
				it(`${accent} on ${neutral}, ${dark ? "dark" : "light"}`, () => {
					const failures = pairs(accent, neutral, dark)
						.map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }))
						.filter((p) => p.ratio < FLOOR)
						.map((p) => `${p.name}: ${p.ratio.toFixed(2)}:1 (${p.fg} on ${p.bg})`);
					expect(failures).toEqual([]);
				});
			}
		}
	}
});

describe("palettes.css shape", () => {
	it("defines exactly the accents and tones the picker offers", () => {
		const found = (key: string) =>
			[...palettes.keys()]
				.map((s) => s.match(new RegExp(`^:root\\[${key}="(\\w+)"\\]$`))?.[1])
				.filter((v): v is string => !!v);
		expect(new Set(found("data-accent"))).toEqual(new Set(ACCENTS.filter((a) => a !== "blue")));
		expect(new Set(found("data-neutral"))).toEqual(new Set(NEUTRALS.filter((n) => n !== "gray")));
	});

	it("overrides in the dark block every token the light block overrides", () => {
		// A token set only in the light rule would leak into dark: `:root[data-x]` outranks tokens.css's `.dark`.
		for (const [selector, vars] of palettes) {
			const m = selector.match(/^:root\[(data-\w+)="(\w+)"\]$/);
			if (!m) continue;
			const dark = palettes.get(`:root.dark[${m[1]}="${m[2]}"]`) ?? {};
			for (const name of Object.keys(vars).filter((n) => n.startsWith("--colour-"))) {
				expect(Object.keys(dark), `${selector} sets ${name}`).toContain(name);
			}
		}
	});

	it("keeps every accent's hover step distinct from its resting step", () => {
		for (const accent of accents.filter((a) => a !== "blue")) {
			const v = resolve(accent, "gray", false);
			expect(v["--color-blue-700"]).not.toBe(v["--color-blue-600"]);
			expect(v["--colour-accent-solid-hover"]).not.toBe(v["--colour-accent-solid"]);
		}
	});

	it("paints the picker's swatches with the colours the palettes really use", () => {
		for (const accent of accents) {
			expect(ACCENT_SWATCHES[accent as keyof typeof ACCENT_SWATCHES], accent).toBe(
				resolve(accent, "gray", false)["--colour-accent-solid"]
			);
		}
		for (const neutral of neutrals) {
			expect(NEUTRAL_SWATCHES[neutral as keyof typeof NEUTRAL_SWATCHES], neutral).toBe(
				resolve("blue", neutral, false)["--color-gray-500"]
			);
		}
	});
});
