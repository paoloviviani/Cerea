import { describe, expect, it } from "vitest";
import { guardCerea, guardPanel, mayOpenExternally } from "../src/main/navGuard.ts";

const origin = "https://cerea.example.org";
const state = { origin };

describe("Cerea window navigation guard", () => {
	it("allows its own origin and nothing else by a click", () => {
		expect(guardCerea(state, "navigate", `${origin}/chat/x`, `${origin}/`).decision).toBe("allow");
		expect(guardCerea(state, "navigate", "https://evil.example/", `${origin}/`).decision).toBe(
			"external"
		);
		expect(guardCerea(state, "window-open", "https://evil.example/", `${origin}/`).decision).toBe(
			"external"
		);
	});

	it("refuses non-web schemes outright and loads nothing before a server is chosen", () => {
		for (const u of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,x",
			"blob:https://x/1",
		]) {
			expect(guardCerea(state, "navigate", u, `${origin}/`).decision).toBe("deny");
		}
		expect(guardCerea({ origin: "" }, "navigate", origin, "").decision).toBe("deny");
	});

	it("is not fooled by look-alike origins", () => {
		for (const u of [
			"https://cerea.example.org.evil.example/",
			"http://cerea.example.org/",
			"https://cerea.example.org:8443/",
			"https://user@cerea.example.org.evil/",
		]) {
			expect(guardCerea(state, "navigate", u, `${origin}/`).decision).toBe("external");
		}
	});

	it("lets a server redirect take the window to the identity provider and back, once", () => {
		const idp = "https://idp.example.org/authorize?x=1";
		const r = guardCerea(state, "redirect", idp, `${origin}/login`);
		expect(r.decision).toBe("allow");
		const excursion = r.excursion!;
		expect(excursion.origin).toBe("https://idp.example.org");
		const s2 = { origin, excursion };
		// inside the excursion: the provider's own pages, and its redirects
		expect(guardCerea(s2, "navigate", "https://idp.example.org/login", idp).decision).toBe("allow");
		expect(guardCerea(s2, "redirect", `${origin}/callback?code=1`, idp).decision).toBe("allow");
		// a third site is not reachable by a click from there
		expect(guardCerea(s2, "navigate", "https://evil.example/", idp).decision).toBe("external");
		// a redirect chain (the provider federating to another) may go on, over https only
		expect(guardCerea(s2, "redirect", "https://upstream.example/", idp).decision).toBe("allow");
		expect(guardCerea(s2, "redirect", "http://upstream.example/", idp).decision).toBe("external");
		// and the excursion lapses
		const late = Date.now() + 11 * 60 * 1000;
		expect(guardCerea(s2, "navigate", "https://idp.example.org/login", idp, late).decision).toBe(
			"external"
		);
	});

	it("does not start an excursion from a click or to an insecure provider", () => {
		expect(guardCerea(state, "navigate", "https://idp.example.org/", `${origin}/`).decision).toBe(
			"external"
		);
		expect(
			guardCerea(state, "redirect", "http://idp.example.org/", `${origin}/login`).decision
		).toBe("external");
		expect(
			guardCerea(state, "redirect", "https://idp.example.org/", "https://other.example/").decision
		).toBe("external");
	});

	it("opens only web and mail links outside", () => {
		expect(mayOpenExternally("https://a.example")).toBe(true);
		expect(mayOpenExternally("mailto:a@b.example")).toBe(true);
		expect(mayOpenExternally("file:///etc/passwd")).toBe(false);
		expect(mayOpenExternally("smb://x")).toBe(false);
	});
});

describe("browser panel navigation guard", () => {
	it("allows web pages and the blank page only", () => {
		expect(guardPanel("https://a.example/")).toBe("allow");
		expect(guardPanel("about:blank")).toBe("allow");
		for (const u of [
			"file:///etc/passwd",
			"chrome://gpu",
			"devtools://x",
			"javascript:1",
			"data:text/html,x",
			"view-source:https://a",
			"nope",
		]) {
			expect(guardPanel(u)).toBe("deny");
		}
	});
});
