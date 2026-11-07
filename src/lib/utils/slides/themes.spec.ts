import { describe, it, expect } from "vitest";
import {
	BUILTIN_THEME_IDS,
	DEFAULT_THEME,
	THEME_IDS,
	resolveTheme,
	sanitizeAccent,
	sanitizeFont,
	sanitizeLogo,
	sanitizeOrgDefaults,
	sanitizeTheme,
} from "./themes";

describe("sanitizers", () => {
	it("normalises accents and refuses anything else", () => {
		expect(sanitizeAccent("#ABC")).toBe("#aabbcc");
		expect(sanitizeAccent("0a7e8c")).toBe("#0a7e8c");
		for (const bad of ["red", "#12", "#1234567", "#fff;}", "url(x)", 5, undefined]) {
			expect(sanitizeAccent(bad)).toBeUndefined();
		}
	});

	it("accepts the eight themes by name, case and spacing aside", () => {
		expect(THEME_IDS).toEqual(["cerea", "cerea-dark", ...BUILTIN_THEME_IDS]);
		expect(sanitizeTheme("Cerea Dark")).toBe("cerea-dark");
		expect(sanitizeTheme("beige")).toBeUndefined();
	});

	it("accepts only the safe font list", () => {
		expect(sanitizeFont("Serif")).toBe("serif");
		expect(sanitizeFont("Arial")).toBeUndefined();
	});

	it("limits the logo to a plain image name or an image data URL", () => {
		expect(sanitizeLogo("my logo (2).svg")).toBe("my logo (2).svg");
		expect(sanitizeLogo("javascript:alert(1)")).toBeUndefined();
		expect(sanitizeLogo(`data:image/png;base64,${"A".repeat(500_000)}`)).toBeUndefined();
	});

	it("keeps only the three organisation knobs", () => {
		expect(
			sanitizeOrgDefaults({
				theme: "moon",
				accent: "#fff",
				logo: "logo.png",
				css: "body{}",
			})
		).toEqual({ theme: "moon", accent: "#ffffff" });
		expect(sanitizeOrgDefaults("nope")).toEqual({});
	});
});

describe("resolveTheme", () => {
	it("defaults to the Cerea theme with its own accent", () => {
		const t = resolveTheme();
		expect(t.theme).toBe(DEFAULT_THEME);
		expect(t.css).toContain("--r-link-color:#7008e7");
		expect(t.css).toContain("--r-background-color:#ffffff");
	});

	it("uses the organisation default, and the deck wins over it", () => {
		const org = {
			theme: "cerea-dark" as const,
			accent: "#00aa77",
			logo: "data:image/png;base64,AA==",
		};
		const fromOrg = resolveTheme({}, org);
		expect(fromOrg.theme).toBe("cerea-dark");
		expect(fromOrg.css).toContain("--cerea-accent:#00aa77");
		expect(fromOrg.logo).toBe(org.logo);
		const deck = resolveTheme({ theme: "white", accent: "#112233" }, org);
		expect(deck.theme).toBe("white");
		expect(deck.css).toContain("--r-link-color:#112233");
		expect(deck.css).not.toContain("#00aa77");
	});

	it("leaves a built-in theme's own colours and fonts alone unless the deck overrides them", () => {
		const plain = resolveTheme({ theme: "dracula" });
		expect(plain.css).not.toContain("--r-background-color:");
		expect(plain.css).not.toContain("--r-main-font");
		const custom = resolveTheme({ theme: "dracula", accent: "#ff0000", font: "mono" });
		expect(custom.css).toContain("--r-link-color:#ff0000");
		expect(custom.css).toContain("--r-main-font:ui-monospace");
	});

	it("applies an org accent to a built-in theme", () => {
		const t = resolveTheme({ theme: "simple" }, { accent: "#0a7e8c" });
		expect(t.css).toContain("--r-link-color:#0a7e8c");
	});

	it("emits only declarations, never a deck-supplied string", () => {
		const t = resolveTheme({ accent: "#abcdef", font: "serif" });
		expect(t.css).toMatch(/^:root\{[^{}<>]*\}$/);
	});
});
