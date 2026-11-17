/**
 * The public routes (ADR 0120), through the real hook: what a visitor gets,
 * with and without a session, on the app's origin and on a share subdomain.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("$lib/server/config", async (original) => {
	const actual = await original<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (target, p: string | symbol) =>
				typeof p === "string" && p in env.values ? env.values[p] : Reflect.get(target, p),
		}),
	};
});
vi.mock("$lib/server/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/auth")>()),
	loginEnabled: true,
}));

const { ready } = await import("$lib/server/database");
await ready;
const { collections } = await import("$lib/server/database");
const { cleanupTestData, createTestConversation, createTestUser } =
	await import("$lib/server/api/__tests__/testHelpers");
const { testRequest } = await import("$lib/server/__tests__/testRequest");
const shares = await import("./shares");
const { setSharingEnabled, forgetSharingSettingsCache } = await import("./settings");
const { resetShareRateLimit, shareRateLimited, SHARE_REQUESTS_PER_MINUTE } =
	await import("./rateLimit");
const { storeDeliverable } = await import("$lib/server/execution/deliverables");
import type { RequestHandler } from "@sveltejs/kit";
// The routes' own handlers are typed by their params; the harness takes the general one.
const general = (handler: unknown) => handler as RequestHandler;
const { GET: PAGE_ROUTE } = await import("../../../routes/s/[token]/+server");
const { GET: DOC_ROUTE } = await import("../../../routes/s/[token]/doc/+server");
const { GET: FILE_ROUTE } = await import("../../../routes/s/[token]/file/[...name]/+server");
const PAGE = general(PAGE_ROUTE);
const DOC = general(DOC_ROUTE);
const FILE = general(FILE_ROUTE);

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	env.values = {};
	resetShareRateLimit();
	await collections.sharedArtifacts.deleteMany({});
	await collections.shareSettings.deleteMany({});
	forgetSharingSettingsCache();
	await cleanupTestData();
});

const message = (id: string, content: string) =>
	({
		id,
		from: "assistant",
		content,
		createdAt: new Date(),
		updatedAt: new Date(),
		children: [],
	}) as never;

async function owned(type: string, body: string, audience: "anyone" | "signed_in") {
	const owner = await createTestUser();
	const chat = await createTestConversation(owner.locals, {
		title: "Chat",
		messages: [
			message("m1", `<artifact identifier="a" type="${type}" title="My page">${body}</artifact>`),
		],
	});
	const made = await shares.createShare(owner.user, {
		conversationId: chat._id,
		target: { kind: "text", identifier: "a" },
		audience,
	});
	return { owner, chat, made };
}

const page = (token: string, query = "", init: { headers?: HeadersInit; origin?: string } = {}) =>
	testRequest(PAGE, {
		path: `${init.origin ?? ""}/s/${token}${query}`,
		routeId: "/s/[token]",
		params: { token },
		headers: init.headers,
	});
const doc = (token: string, query = "", init: { headers?: HeadersInit; origin?: string } = {}) =>
	testRequest(DOC, {
		path: `${init.origin ?? ""}/s/${token}/doc${query}`,
		routeId: "/s/[token]/doc",
		params: { token },
		headers: init.headers,
	});

/** What no public response may carry. */
function expectPublicHeaders(res: Response) {
	expect(res.headers.get("set-cookie")).toBeNull();
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	expect(res.headers.get("x-robots-tag")).toContain("noindex");
	expect(res.headers.get("cache-control")).toContain("no-store");
}

describe("an anyone link", () => {
	it("serves Markdown in a read-only viewer under the band, with a download", async () => {
		const { made } = await owned(
			"markdown",
			"# Hello **world**\n\n<script>alert(1)</script>",
			"anyone"
		);
		const token = new URL(made.token, "http://x/").pathname.slice(1);
		const res = await page(token);
		expect(res.status).toBe(200);
		expectPublicHeaders(res);
		const html = await res.text();
		expect(html).toContain("Shared from Cerea by Test User: not an official page");
		expect(html).toContain("<strong>world</strong>");
		// Raw HTML in the Markdown is escaped, and the page itself runs no script.
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
		expect(html).toMatch(/href="\/s\/[\w-]+\/file\/a\.md"/);
	});

	it("serves a table as a grid", async () => {
		const { made } = await owned("table", "name,qty\nbolt,3\n", "anyone");
		const html = await (await page(made.token)).text();
		expect(html).toContain("<th>name</th>");
		expect(html).toContain("<td>bolt</td>");
	});

	it("wraps HTML in a band and frames the document from a sibling URL", async () => {
		const { made } = await owned("html", "<h1>Hi</h1><script>1+1</script>", "anyone");
		const res = await page(made.token);
		expect(res.status).toBe(200);
		expectPublicHeaders(res);
		const html = await res.text();
		expect(html).toContain("Shared from Cerea by Test User: not an official page");
		expect(html).toContain('sandbox="allow-scripts"');
		expect(html).toContain(`src="/s/${made.token}/doc"`);
		// The band is in this page; the artifact's document is a different one.
		expect(html).not.toContain("<h1>Hi</h1>");
	});

	it("serves the document with exactly the sandbox policy and no cookies", async () => {
		const { made } = await owned("html", "<h1>Hi</h1><script>1+1</script>", "anyone");
		const res = await doc(made.token);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
		expectPublicHeaders(res);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<h1>Hi</h1>");
		expect(html).not.toContain("Shared from Cerea");
	});

	it("sends a top-level navigation to the document back to the page with the band", async () => {
		const { made } = await owned("html", "<p>x</p>", "anyone");
		const res = await doc(made.token, "", { headers: { "sec-fetch-dest": "document" } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(`/s/${made.token}`);
		const framed = await doc(made.token, "", { headers: { "sec-fetch-dest": "iframe" } });
		expect(framed.status).toBe(200);
	});

	it("does not serve a viewer kind as a running document", async () => {
		const { made } = await owned("markdown", "# x", "anyone");
		expect((await doc(made.token)).status).toBe(404);
	});

	it("counts the view", async () => {
		const { made, chat } = await owned("markdown", "# x", "anyone");
		await page(made.token);
		await page(made.token);
		const row = await collections.sharedArtifacts.findOne({ conversationId: chat._id });
		expect(row?.views).toBe(1);
	});
});

describe("a link that does not resolve answers alike", () => {
	async function body(res: Response) {
		return { status: res.status, text: await res.text() };
	}

	it("unknown, revoked, expired and switched-off links are the same 404", async () => {
		const unknown = await body(await page("A".repeat(22)));
		expect(unknown.status).toBe(404);

		const { owner, made } = await owned("markdown", "# x", "anyone");
		expect((await page(made.token)).status).toBe(200);

		await setSharingEnabled(false);
		const off = await page(made.token);
		expectPublicHeaders(off);
		expect(await body(off)).toEqual(unknown);
		expect((await doc(made.token)).status).toBe(404);
		await setSharingEnabled(true);
		expect((await page(made.token)).status).toBe(200);

		await collections.sharedArtifacts.updateOne(
			{ _id: new ObjectId(made.id) },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		expect(await body(await page(made.token))).toEqual(unknown);
		await collections.sharedArtifacts.updateOne(
			{ _id: new ObjectId(made.id) },
			{ $set: { expiresAt: null } }
		);
		expect((await page(made.token)).status).toBe(200);

		await shares.revokeShare({ id: owner.user._id }, new ObjectId(made.id));
		expect(await body(await page(made.token))).toEqual(unknown);
	});

	it("says so in plain words and sets no cookie", async () => {
		const res = await page("A".repeat(22));
		const text = await res.text();
		expect(text).toContain("Not available");
		expect(res.headers.get("set-cookie")).toBeNull();
	});
});

describe("a signed-in link on the app's own origin", () => {
	it("sends a visitor without a session to sign in, and back", async () => {
		const { made } = await owned("markdown", "# x", "signed_in");
		const res = await page(made.token);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			`/login?next=${encodeURIComponent(`/s/${made.token}`)}`
		);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect((await doc(made.token)).status).toBe(404);
	});

	it("opens for a session, and the frame loads with the same session", async () => {
		const { made } = await owned("html", "<p>mine</p>", "signed_in");
		const visitor = await createTestUser();
		const headers = { cookie: visitor.cookie };
		const res = await page(made.token, "", { headers });
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(await res.text()).toContain(`src="/s/${made.token}/doc"`);
		const framed = await doc(made.token, "", { headers });
		expect(framed.status).toBe(200);
		expect(framed.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
		expect((await doc(made.token)).status).toBe(404);
	});
});

describe("a share subdomain", () => {
	const SHARE = "https://share.example.org";
	const configure = () => {
		env.values = { ARTIFACT_SHARE_ORIGIN: SHARE, PUBLIC_ORIGIN: "https://app.example.org" };
	};
	const onShare = (
		path: string,
		routeId: "/s/[token]" | "/s/[token]/doc",
		token: string,
		headers: HeadersInit = {}
	) =>
		testRequest(routeId.endsWith("/doc") ? DOC : PAGE, {
			path: `${SHARE}${path}`,
			routeId,
			params: { token },
			headers: { host: "share.example.org", ...headers },
		});

	it("refuses an anyone link on the app's own host", async () => {
		const { made } = await owned("markdown", "# x", "anyone");
		configure();
		expect((await page(made.token)).status).toBe(404);
		expect((await doc(made.token)).status).toBe(404);
	});

	it("serves an anyone link on the share host, reads no cookie and sets none", async () => {
		const { made } = await owned("markdown", "# On the share host", "anyone");
		configure();
		const visitor = await createTestUser();
		const sessionsBefore = await collections.sessions.countDocuments({});
		const res = await onShare(`/s/${made.token}`, "/s/[token]", made.token, {
			cookie: visitor.cookie,
		});
		expect(res.status).toBe(200);
		expectPublicHeaders(res);
		expect(await collections.sessions.countDocuments({})).toBe(sessionsBefore);
		expect(await res.text()).toContain("On the share host");
	});

	it("links the frame from the share host's own root", async () => {
		const { made } = await owned("html", "<p>x</p>", "anyone");
		configure();
		const res = await onShare(`/s/${made.token}`, "/s/[token]", made.token);
		expect(await res.text()).toContain(`src="/${made.token}/doc"`);
	});

	it("never serves a signed-in link on the share host, even to a session", async () => {
		const { made } = await owned("markdown", "# private", "signed_in");
		configure();
		const visitor = await createTestUser();
		const res = await onShare(`/s/${made.token}`, "/s/[token]", made.token, {
			cookie: visitor.cookie,
		});
		expect(res.status).toBe(404);
	});

	it("serves a signed-in link on the app's origin, with the session", async () => {
		const { made } = await owned("markdown", "# private", "signed_in");
		configure();
		const visitor = await createTestUser();
		const ok = await page(made.token, "", { headers: { cookie: visitor.cookie } });
		expect(ok.status).toBe(200);
		expect((await page(made.token)).status).toBe(302);
	});
});

describe("a file artifact", () => {
	async function sharedFile(audience: "anyone" | "signed_in" = "anyone") {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, { title: "Files" });
		const stored = await storeDeliverable({
			conversationId: chat._id,
			userId: owner.user._id,
			name: "report.pdf",
			mime: "text/html",
			bytes: Buffer.from("%PDF-1.4 fake"),
		});
		if (!stored.ok) throw new Error("store failed");
		const made = await shares.createShare(owner.user, {
			conversationId: chat._id,
			target: { kind: "file", name: "report.pdf", sha256: stored.ref.sha256 },
			audience,
		});
		return { owner, chat, made };
	}
	const file = (token: string, name: string, query = "") =>
		testRequest(FILE, {
			path: `/s/${token}/file/${name}${query}`,
			routeId: "/s/[token]/file/[...name]",
			params: { token, name: decodeURIComponent(name) },
		});

	it("shows a viewer with a download, and downloads as an attachment of a safe type", async () => {
		const { made } = await sharedFile();
		const viewer = await page(made.token);
		const html = await viewer.text();
		expect(html).toContain("report.pdf");
		expect(html).toContain(`/s/${made.token}/file/report.pdf`);
		const res = await file(made.token, "report.pdf");
		expect(res.status).toBe(200);
		expectPublicHeaders(res);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		// The stored type said text/html; a download never carries one a browser would run.
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(await res.text()).toBe("%PDF-1.4 fake");
	});

	it("refuses any other name, including path tricks", async () => {
		const { made } = await sharedFile();
		for (const name of [
			"other.pdf",
			"..%2Freport.pdf",
			"%2e%2e%2f%2e%2e%2fetc%2fpasswd",
			"report.pdf%00.png",
			"report.pdf/..",
			"%5C..%5Creport.pdf",
		]) {
			const res = await file(made.token, name);
			expect(res.status, name).toBe(404);
		}
	});

	it("is gone with the stored file, and with the link", async () => {
		const { made, chat, owner } = await sharedFile();
		await collections.codeExecutionOutputs.deleteMany({ conversationId: chat._id });
		expect((await file(made.token, "report.pdf")).status).toBe(404);
		await shares.revokeShare({ id: owner.user._id }, new ObjectId(made.id));
		expect((await file(made.token, "report.pdf")).status).toBe(404);
	});

	it("refuses a download of a signed-in link without the pass", async () => {
		const { made } = await sharedFile("signed_in");
		expect((await file(made.token, "report.pdf")).status).toBe(404);
	});

	it("will not share a file that is not in the chat", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, { title: "Files" });
		await expect(
			shares.createShare(owner.user, {
				conversationId: chat._id,
				target: { kind: "file", name: "x.pdf", sha256: "0".repeat(64) },
			})
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("a text artifact's download", () => {
	it("is the snapshot's source as an attachment", async () => {
		const { made } = await owned("markdown", "# Title", "anyone");
		const res = await testRequest(FILE, {
			path: `/s/${made.token}/file/a.md`,
			routeId: "/s/[token]/file/[...name]",
			params: { token: made.token, name: "a.md" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain('attachment; filename="a.md"');
		expect(res.headers.get("content-type")).toBe("text/plain");
		expect(await res.text()).toBe("# Title");
	});
});

describe("the rate limit", () => {
	it("allows a burst, then refuses from the same address, and answers 429 on the route", async () => {
		for (let i = 0; i < SHARE_REQUESTS_PER_MINUTE; i++) {
			expect(shareRateLimited("203.0.113.9")).toBe(false);
		}
		expect(shareRateLimited("203.0.113.9")).toBe(true);
		expect(shareRateLimited("203.0.113.10")).toBe(false);
		const res = await page("A".repeat(22));
		// testRequest's address is 127.0.0.1: use up its allowance, then it is refused.
		for (let i = 0; i < SHARE_REQUESTS_PER_MINUTE; i++) shareRateLimited("127.0.0.1");
		const refused = await page("A".repeat(22));
		expect(res.status).toBe(404);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("set-cookie")).toBeNull();
	});
});
