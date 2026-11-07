import { describe, it, expect } from "vitest";
import {
	BUILTIN_THEME_IDS,
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
				font: "Serif",
				logo: "logo.png",
				css: "body{}",
			})
		).toEqual({ accent: "#ffffff", font: "serif" });
		expect(sanitizeOrgDefaults("nope")).toEqual({});
	});
});

describe("resolveTheme", () => {
	it("applies no theme by default, only brand variables", () => {
		const t = resolveTheme();
		expect(t.theme).toBeUndefined();
		expect(t.css).toContain("--brand-accent:#7008e7");
		expect(t.css).toContain("--brand-font:Inter");
		expect(t.css).not.toContain("--r-");
		expect(t.css).not.toContain("--brand-logo-url");
	});

	it("takes the brand from the organisation, and the deck wins over it", () => {
		const org = { accent: "#00aa77", font: "serif" as const, logo: "data:image/png;base64,AA==" };
		const fromOrg = resolveTheme({}, org);
		expect(fromOrg.css).toContain("--brand-accent:#00aa77");
		expect(fromOrg.css).toContain("--brand-font:Charter");
		expect(fromOrg.css).toContain('--brand-logo-url:url("data:image/png;base64,AA==")');
		const deck = resolveTheme({ accent: "#112233", font: "mono" }, org);
		expect(deck.css).toContain("--brand-accent:#112233");
		expect(deck.css).toContain("--brand-font:ui-monospace");
		expect(deck.css).not.toContain("#00aa77");
	});

	it("applies a named theme's variables only when asked", () => {
		const cerea = resolveTheme({ theme: "cerea-dark" });
		expect(cerea.css).toContain("--r-background-color:#111827");
		expect(cerea.css).toContain("--r-link-color:#a78bfa");
		const dracula = resolveTheme({ theme: "dracula" });
		expect(dracula.css).not.toContain("--r-background-color:");
		expect(dracula.css).toContain("--cerea-accent:var(--r-link-color)");
	});

	it("lets the brand accent override a theme's link colour", () => {
		const t = resolveTheme({ theme: "simple" }, { accent: "#0a7e8c" });
		expect(t.css).toContain("--r-link-color:#0a7e8c");
		const named = resolveTheme({ theme: "cerea", accent: "#112233" });
		expect(named.css).toContain("--r-link-color:#112233");
	});

	it("emits only declarations, never a deck-supplied string", () => {
		const t = resolveTheme({ accent: "#abcdef", font: "serif" });
		expect(t.css).toMatch(/^:root\{[^{}<>]*\}$/);
	});
});
