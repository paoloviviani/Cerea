import { describe, expect, it } from "vitest";
import {
	guardCerea,
	guardPanel,
	MAX_UPSTREAM,
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
		// a provider upstream of the server's own: by a redirect only, https only
		expect(guardCerea(s2, "redirect", "https://upstream.example/", idp).decision).toBe("allow");
		expect(guardCerea(s2, "navigate", "https://upstream.example/", idp).decision).toBe("external");
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

describe("signing in through an upstream provider (GitLab, then Microsoft)", () => {
	const server = "https://cerea.example.org";
	const gitlab = "https://gitlab.example.org";
	const ms = "https://login.microsoftonline.com";
	const setup = (t0 = Date.now()) => {
		const guard: GuardState = { origin: server, idp: gitlab };
		const chain = new NavChain(`${server}/chat/`);
		const step = (kind: "navigate" | "redirect" | "window-open", url: string, now = t0) => {
			const r = chain.handle(guard, kind, url, now);
			if (r.excursion !== undefined) guard.excursion = r.excursion ?? undefined;
			return r.decision;
		};
		return { guard, chain, step, t0 };
	};

	it("follows the whole chain in the app: server, GitLab, Microsoft, GitLab, server", () => {
		const { guard, step } = setup();
		expect(step("redirect", `${server}/chat/login`)).toBe("allow");
		expect(step("redirect", `${gitlab}/oauth/authorize?client_id=x`)).toBe("allow");
		expect(step("redirect", `${gitlab}/users/sign_in`)).toBe("allow");
		// the user picks "Sign in with Microsoft": a click inside GitLab, then GitLab redirects
		expect(step("navigate", `${gitlab}/users/auth/openid_connect`)).toBe("allow");
		expect(step("redirect", `${ms}/common/oauth2/v2.0/authorize?x=1`)).toBe("allow");
		expect(guard.excursion?.chain).toEqual([gitlab, ms]);
		// Microsoft's own pages (password, MFA, "stay signed in")
		expect(step("navigate", `${ms}/common/login`)).toBe("allow");
		// Microsoft hands the answer back to GitLab: by a form post (a navigate) here
		expect(step("navigate", `${gitlab}/users/auth/openid_connect/callback`)).toBe("allow");
		expect(guard.excursion?.origin).toBe(gitlab);
		// and GitLab sends the window home, which ends the sign-in
		expect(step("redirect", `${server}/chat/login/callback?code=1`)).toBe("allow");
		expect(guard.excursion).toBeUndefined();
	});

	it("accepts Microsoft's answer by redirect too", () => {
		const { step } = setup();
		step("redirect", `${gitlab}/oauth/authorize`);
		step("redirect", `${ms}/authorize`);
		expect(step("redirect", `${gitlab}/users/auth/openid_connect/callback?code=1`)).toBe("allow");
	});

	it("reaches a third origin only by a redirect from the page the window is on", () => {
		const { guard, step } = setup();
		step("redirect", `${gitlab}/oauth/authorize`);
		// a click or a script on GitLab cannot open Microsoft (or anything new) in the app
		expect(step("navigate", `${ms}/authorize`)).toBe("external");
		expect(step("window-open", `${ms}/authorize`)).toBe("external");
		// a redirect claimed from somewhere the window is not, is refused
		expect(
			guardCerea(guard, "redirect", `${ms}/authorize`, "https://evil.example/x").decision
		).toBe("external");
		// nor can a hostile page on a reached origin click its way to a new one
		step("redirect", `${ms}/authorize`);
		expect(step("navigate", "https://evil.example/phish")).toBe("external");
		expect(step("window-open", "https://evil.example/phish")).toBe("external");
		expect(guard.excursion?.chain).toEqual([gitlab, ms]);
	});

	it("takes https only for an upstream hop", () => {
		const { step } = setup();
		step("redirect", `${gitlab}/oauth/authorize`);
		expect(step("redirect", "http://login.microsoftonline.com/authorize")).toBe("external");
	});

	it(`stops at ${MAX_UPSTREAM} origins beyond the server's provider`, () => {
		const { guard, step } = setup();
		step("redirect", `${gitlab}/oauth/authorize`);
		for (let i = 1; i <= MAX_UPSTREAM; i++) {
			expect(step("redirect", `https://hop${i}.example/`)).toBe("allow");
		}
		expect(step("redirect", "https://one-too-many.example/")).toBe("external");
		expect(guard.excursion?.chain).toHaveLength(1 + MAX_UPSTREAM);
		// the hops already reached stay reachable (the way back)
		expect(step("redirect", `${gitlab}/callback`)).toBe("allow");
	});

	it("keeps the clock of the first hop: later hops never extend it", () => {
		const { guard, step, t0 } = setup();
		step("redirect", `${gitlab}/oauth/authorize`, t0);
		const nine = t0 + 9 * 60 * 1000;
		expect(step("redirect", `${ms}/authorize`, nine)).toBe("allow");
		expect(guard.excursion?.since).toBe(t0);
		expect(step("navigate", `${ms}/login`, nine)).toBe("allow");
		expect(step("navigate", `${gitlab}/callback`, nine)).toBe("allow");
		expect(guard.excursion?.since).toBe(t0);
		// past 10 minutes from the first hop, nothing of the sign-in is reachable any more
		const eleven = t0 + 11 * 60 * 1000;
		expect(step("navigate", `${gitlab}/users/sign_in`, eleven)).toBe("external");
		expect(step("redirect", `${ms}/authorize`, eleven)).toBe("external");
		// and only a fresh redirect from the server starts a new one
		expect(
			guardCerea(guard, "redirect", `${ms}/authorize`, `${server}/chat/login`, eleven).decision
		).toBe("external");
	});

	it("does not let an upstream provider start a sign-in on its own", () => {
		const guard: GuardState = { origin: server, idp: gitlab };
		expect(guardCerea(guard, "redirect", `${ms}/authorize`, `${server}/chat/login`).decision).toBe(
			"external"
		);
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
