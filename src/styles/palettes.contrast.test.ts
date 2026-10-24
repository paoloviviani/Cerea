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
		// `a, b { … }` applies to both selectors; the default tone is written that way.
		for (const sel of selector.split(",").map((x) => x.trim())) {
			const vars: Vars = out.get(sel) ?? {};
			for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
				vars[name] = value.trim();
			}
			out.set(sel, vars);
		}
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
	// Blue is the default accent: no attribute, so no rule. The default tone is
	// `neutral`, whose rules also match a bare <html>.
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
			(
				[
					"--colour-bg",
					"--colour-sidebar",
					"--colour-surface",
					"--colour-surface-raised",
					"--colour-surface-sunken",
				] as const
			)
				// Light mode's surface-raised is tokens.css's white; sidebar is palettes.css's.
				.map((ground) => ({
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
const neutrals = [...NEUTRALS];

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
		expect(new Set(found("data-neutral"))).toEqual(new Set(NEUTRALS));
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
			const v = resolve(accent, "neutral", false);
			expect(v["--color-blue-700"]).not.toBe(v["--color-blue-600"]);
			expect(v["--colour-accent-solid-hover"]).not.toBe(v["--colour-accent-solid"]);
		}
	});

	it("paints the picker's swatches with the colours the palettes really use", () => {
		for (const accent of accents) {
			expect(ACCENT_SWATCHES[accent as keyof typeof ACCENT_SWATCHES], accent).toBe(
				resolve(accent, "neutral", false)["--colour-accent-solid"]
			);
		}
		for (const neutral of neutrals) {
			expect(NEUTRAL_SWATCHES[neutral as keyof typeof NEUTRAL_SWATCHES], neutral).toBe(
				resolve("blue", neutral, false)["--color-gray-500"]
			);
		}
	});
});

/* -- the tones' shared structure ---------------------------------------------- */

function linear(hex: string): [number, number, number] {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return [r, g, b];
}

/** OKLab lightness, 0..1: the scale the elevation steps are specified in. */
function oklabL(hex: string): number {
	const [r, g, b] = linear(hex);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** CIE76 ΔE: the metric the tone prototypes were measured in. */
function deltaE(a: string, b: string): number {
	const lab = (hex: string) => {
		const [r, g, bl] = linear(hex);
		const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
		const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / 0.95047);
		const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * bl);
		const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * bl) / 1.08883);
		return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
	};
	const [p, q] = [lab(a), lab(b)];
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

describe("dark elevation ladder", () => {
	for (const neutral of neutrals) {
		it(`${neutral}: page < sidebar < card < composer, in steady lightness steps`, () => {
			const v = resolve("blue", neutral, true);
			const rungs = [
				"--colour-bg",
				"--colour-sidebar",
				"--colour-surface",
				"--colour-surface-raised",
			];
			const L = rungs.map((r) => oklabL(hexOf(v, r)));
			const steps = L.slice(1).map((l, i) => l - L[i]);
			for (const step of steps) {
				expect(step).toBeGreaterThan(0.025);
				expect(step).toBeLessThan(0.045);
			}
			// Steady: no step more than 30% off another, so no rung looks skipped or doubled.
			expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.3);
		});
	}
});

describe("the tones are clearly different", () => {
	it("Cool is at least ΔE 3.5 from Neutral on the light page, and Warm too", () => {
		const page = (n: string, dark: boolean) => hexOf(resolve("blue", n, dark), "--colour-bg");
		expect(deltaE(page("neutral", false), page("cool", false))).toBeGreaterThanOrEqual(3.5);
		expect(deltaE(page("neutral", false), page("warm", false))).toBeGreaterThanOrEqual(3.5);
		expect(deltaE(page("cool", false), page("warm", false))).toBeGreaterThanOrEqual(3.5);
	});
	it("dark pages are told apart too", () => {
		const page = (n: string) => hexOf(resolve("blue", n, true), "--colour-bg");
		expect(deltaE(page("neutral"), page("cool"))).toBeGreaterThanOrEqual(2);
		expect(deltaE(page("neutral"), page("warm"))).toBeGreaterThanOrEqual(2);
	});
	it("Cool never turns navy: light page and ink stay near-neutral in lightness", () => {
		const v = resolve("blue", "cool", false);
		expect(oklabL(hexOf(v, "--colour-bg"))).toBeGreaterThan(0.95);
		expect(oklabL(hexOf(v, "--colour-text"))).toBeLessThan(0.2);
	});
});

describe("faint and muted text", () => {
	it("measure the old values as failures, so the floor cannot quietly drop", () => {
		// What the chat used to paint: Tailwind's gray-400 on a light page and gray-500 on a dark one.
		expect(contrast("#a3a3a3", "#ffffff")).toBeLessThan(FLOOR);
		expect(contrast("#737373", "#1a1a1a")).toBeLessThan(FLOOR);
	});

	it("clear 4.5:1 on every ground the chat paints, in every tone and theme", () => {
		const grounds = [
			"--colour-bg",
			"--colour-sidebar",
			"--colour-surface",
			"--colour-surface-raised",
			"--colour-surface-sunken",
		];
		for (const neutral of neutrals) {
			for (const dark of [false, true]) {
				const v = resolve("blue", neutral, dark);
				for (const ink of ["--colour-text-muted", "--colour-text-faint"]) {
					for (const ground of grounds) {
						const ratio = contrast(hexOf(v, ink), hexOf(v, ground));
						expect(
							ratio,
							`${neutral} ${dark ? "dark" : "light"} ${ink} on ${ground}`
						).toBeGreaterThanOrEqual(FLOOR);
					}
				}
			}
		}
	});
});

describe("chat shell text goes through the tokens", () => {
	// These are the faint captions that used to be spelled `text-gray-400`/`-300`
	// (2.5:1 on white). Each must use the faint/muted tokens instead.
	const files: Record<string, RegExp[]> = {
		"../lib/components/nav/TreeBranch.svelte": [/shrink-0 rounded-md[^"]*text-gray-[34]00/],
		"../lib/components/NavMenu.svelte": [/text-gray-500 hover:text-gray-900/],
		"../lib/components/chat/ChatWindow.svelte": [
			/whitespace-nowrap text-gray-400/,
			/text-xs whitespace-nowrap text-gray-400/,
		],
		"../lib/components/chat/ChatInput.svelte": [/text-gray-400 select-none/],
		"../lib/components/chat/ChatMessage.svelte": [
			/text-gray-400 @xl:text-xs/,
			/rounded-xs p-[12] text-(sm|xs) text-gray-400/,
		],
		"../lib/components/chat/ModelEffortPicker.svelte": [
			/shrink-0 text-gray-500 dark:text-gray-400">·/,
		],
	};
	for (const [path, bad] of Object.entries(files)) {
		it(`${path.split("/").pop()} has no hard-coded faint greys`, () => {
			const src = read(path);
			for (const re of bad) expect(src).not.toMatch(re);
		});
	}
	it("the global placeholder and the code-block function name are legible", () => {
		expect(mainCss).toMatch(/::placeholder\s*\{\s*color:\s*var\(--colour-text-faint\)/);
		const hl = read("./highlight-js.css");
		const title =
			hl.match(/\.hljs-selector-id,\s*\.hljs-title\s*\{\s*color:\s*(#[0-9a-f]{6})/i)?.[1] ?? "";
		expect(contrast(title, "#fafafa")).toBeGreaterThanOrEqual(FLOOR);
	});
	it("the composer's fade is the page, never white", () => {
		const col = read("../lib/components/chat/ChatMessageColumn.svelte");
		expect(col).not.toMatch(/from-white|via-white|dark:from-gray-900/);
		expect(col).toMatch(/from-page[\s\S]*via-page[\s\S]*to-page\/0/);
	});
});
