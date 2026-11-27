import { describe, expect, it } from "vitest";
import {
	guardCerea,
	guardPanel,
	mayOpenExternally,
	NavChain,
	type GuardState,
} from "../src/main/navGuard.ts";

const origin = "https://cerea.example.org";
const state = { origin, idp: "https://idp.example.org" };

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
		// a provider upstream of the server's own is not reachable, redirect or not
		expect(guardCerea(s2, "redirect", "https://upstream.example/", idp).decision).toBe("external");
		expect(guardCerea(s2, "redirect", "http://idp.example.org/", idp).decision).toBe("external");
		// and the excursion lapses
		const late = Date.now() + 11 * 60 * 1000;
		expect(guardCerea(s2, "navigate", "https://idp.example.org/login", idp, late).decision).toBe(
			"external"
		);
	});

	it("lets a redirect reach only the identity provider the server named", () => {
		expect(
			guardCerea(state, "redirect", "https://other-idp.example/", `${origin}/login`).decision
		).toBe("external");
		expect(
			guardCerea({ origin }, "redirect", "https://idp.example.org/", `${origin}/login`).decision
		).toBe("external");
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

describe("navigation chain source (NavChain)", () => {
	const idp = "https://idp.example.org";
	const serverAddress = "https://cerea.example.org/chat/";
	const stateOf = (): GuardState => ({ origin: "https://cerea.example.org", idp });

	it("follows the first-load chain: server → /login → the identity provider", () => {
		const guard = stateOf();
		// The view keeps the excursion the way the main process does.
		const apply = (r: ReturnType<typeof chain.handle>) => {
			if (r.excursion !== undefined) guard.excursion = r.excursion ?? undefined;
		};
		// The initial load: the URL the view was loaded at, with nothing committed yet.
		const chain = new NavChain(serverAddress);
		const r1 = chain.handle(guard, "redirect", "https://cerea.example.org/chat/login");
		apply(r1);
		expect(r1.decision).toBe("allow");
		expect(chain.source()).toBe("https://cerea.example.org/chat/login");
		// Nothing is loaded yet, so the view's own URL cannot be used for this hop.
		const r2 = chain.handle(guard, "redirect", "https://idp.example.org/authorize?client=x");
		apply(r2);
		expect(r2.decision).toBe("allow");
		expect(r2.excursion?.origin).toBe(idp);
		const r3 = chain.handle(guard, "redirect", "https://idp.example.org/consent");
		apply(r3);
		expect(r3.decision).toBe("allow");
		expect(chain.source()).toBe("https://idp.example.org/consent");
	});

	it("follows a chain that starts from a committed navigation", () => {
		const guard = stateOf();
		const chain = new NavChain(serverAddress);
		const apply = (r: ReturnType<typeof chain.handle>) => {
			if (r.excursion !== undefined) guard.excursion = r.excursion ?? undefined;
		};
		// The first load commits, then a later navigation to a page that redirects.
		const nav = chain.handle(guard, "navigate", serverAddress);
		apply(nav);
		expect(nav.decision).toBe("allow");
		const r = chain.handle(guard, "navigate", "https://cerea.example.org/chat/login");
		apply(r);
		expect(r.decision).toBe("allow");
		const red = chain.handle(guard, "redirect", "https://idp.example.org/authorize?client=x");
		apply(red);
		expect(red.decision).toBe("allow");
		expect(red.excursion?.origin).toBe(idp);
	});

	it("keeps a chain that starts elsewhere external", () => {
		const guard = stateOf();
		// A chain starting somewhere that is not the server (or an excursion it reached).
		const chain = new NavChain("https://evil.example/");
		expect(
			chain.handle(guard, "redirect", "https://idp.example.org/authorize?client=x").decision
		).toBe("external");
	});

	it("keeps a redirect to a third site external, and leaves the chain where it was", () => {
		const guard = stateOf();
		const chain = new NavChain(serverAddress);
		expect(chain.handle(guard, "navigate", "https://cerea.example.org/chat/login").decision).toBe(
			"allow"
		);
		const r = chain.handle(guard, "redirect", "https://evil.example/");
		expect(r.decision).toBe("external");
		expect(chain.source()).toBe("https://cerea.example.org/chat/login");
	});

	it("keeps a plain navigate to the identity provider external", () => {
		const guard = stateOf();
		const chain = new NavChain(serverAddress);
		expect(chain.handle(guard, "navigate", "https://idp.example.org/login").decision).toBe(
			"external"
		);
		expect(chain.source()).toBe(serverAddress);
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
