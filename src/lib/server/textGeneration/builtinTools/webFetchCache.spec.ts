/**
 * The cross-turn cache behind `web_fetch`, against a real Mongo: what a second
 * turn does and does not download or extract, who can see an entry, and what
 * removes it. The network (`fetchPage`) and the paid extractor are mocked so
 * their call counts can be asserted.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";

const fetchPage = vi.fn();
const extractDocument = vi.fn();
vi.mock("$lib/server/fetching", () => ({ fetchPage }));
vi.mock("$lib/server/files/extractDocument", () => ({ extractDocument }));
const dropMachineConnection = vi.fn();
vi.mock("$lib/server/code/machines", () => ({
	dropMachineConnection: (...args: unknown[]) => dropMachineConnection(...args),
}));

const { performFetch, createWebFetchBuiltin, MAX_FETCH_RESULT_CHARS } =
	await import("./webFetchTool");
const {
	MAX_CONVERSATION_ENTRIES,
	MAX_ENTRY_CHARS,
	DEFAULT_CACHE_DAYS,
	sha256Hex,
	getCachedFetch,
	putCachedFetch,
} = await import("$lib/server/webFetchCache");
const { deleteConversationStorage } = await import("$lib/server/conversationStorage");
const { runErasure } = await import("$lib/server/identity/erasure");

const URL_A = "https://example.test/report.pdf";
const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function pdf(text: string) {
	fetchPage.mockResolvedValue({
		url: URL_A,
		title: null,
		content: "",
		contentType: "application/pdf",
		backend: "direct",
		extracted: false,
		document: { bytes: bytesOf(text), mime: "application/pdf", filename: "report.pdf" },
	});
}

let conv: { conversationId: ObjectId; userId?: ObjectId };
const newScope = (): { conversationId: ObjectId; userId: ObjectId } => ({
	conversationId: new ObjectId(),
	userId: new ObjectId(),
});

/** A later turn: a new per-turn Map, the same persistent scope. */
const turn = (scope = conv, offset = 0) =>
	performFetch(URL_A, { offset, token: "t", cache: new Map(), persist: scope });

const setAge = (scope: typeof conv, ms: number) =>
	collections.webFetchCache.updateMany(
		{ conversationId: scope.conversationId },
		{ $set: { fetchedAt: new Date(Date.now() - ms) } }
	);

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(async () => {
	vi.resetAllMocks();
	await collections.webFetchCache.deleteMany({});
	conv = newScope();
	extractDocument.mockResolvedValue({ ok: true, text: "extracted text", pages: 3 });
});

afterEach(async () => {
	await collections.webFetchCache.deleteMany({});
	await collections.conversations.deleteMany({});
	await collections.erasures.deleteMany({});
	await collections.users.deleteMany({});
});

describe("web_fetch cross-turn cache", () => {
	it("reuses the text in a later turn within the freshness window, with no download and no extraction", async () => {
		pdf("v1");
		const first = await turn();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(extractDocument).toHaveBeenCalledTimes(1);

		const second = await turn();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(extractDocument).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("after the window, downloads again but does not extract when the bytes are unchanged", async () => {
		pdf("v1");
		await turn();
		await setAge(conv, 11 * 60_000);

		const again = await turn();
		expect(fetchPage).toHaveBeenCalledTimes(2);
		expect(extractDocument).toHaveBeenCalledTimes(1);
		expect("resultText" in again.result && again.result.resultText).toContain("extracted text");
		// The clock restarted: the next turn is inside a fresh window again.
		await turn();
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it("after the window, extracts again and replaces the entry when the bytes changed", async () => {
		pdf("v1");
		await turn();
		await setAge(conv, 11 * 60_000);
		pdf("v2");
		extractDocument.mockResolvedValue({ ok: true, text: "new text", pages: 3 });

		const again = await turn();
		expect(extractDocument).toHaveBeenCalledTimes(2);
		expect("resultText" in again.result && again.result.resultText).toContain("new text");
		const rows = await collections.webFetchCache.find({}).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0].text).toBe("new text");
		expect(rows[0].contentHash).toBe(sha256Hex(bytesOf("v2")));
		expect(rows[0].extractedBy).toBe("document");
	});

	it("caches a page's readable text the same way", async () => {
		fetchPage.mockResolvedValue({
			url: URL_A,
			title: "T",
			content: "<p>hello world</p>",
			contentType: "text/html",
			backend: "direct",
			extracted: false,
		});
		await turn();
		await turn();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect((await collections.webFetchCache.findOne({}))?.extractedBy).toBe("html");
	});

	it("pages by offset over cached text exactly as over a fresh extraction", async () => {
		const long = "abcdefghij".repeat(MAX_FETCH_RESULT_CHARS / 5);
		extractDocument.mockResolvedValue({ ok: true, text: long, pages: 9 });
		pdf("big");
		const fresh = await Promise.all([
			turn(conv, 0),
			performFetch(URL_A, { offset: MAX_FETCH_RESULT_CHARS, token: "t", cache: new Map() }),
		]);
		fetchPage.mockClear();
		extractDocument.mockClear();
		const cached = [await turn(conv, 0), await turn(conv, MAX_FETCH_RESULT_CHARS)];
		expect(fetchPage).not.toHaveBeenCalled();
		expect(extractDocument).not.toHaveBeenCalled();
		expect(cached).toEqual(fresh);
	});

	it("is wired through the tool: a second turn's tool does not fetch", async () => {
		pdf("v1");
		const build = () =>
			createWebFetchBuiltin({ allowedUrls: new Set([URL_A]), token: "t", persist: conv });
		await build().execute({ url: URL_A }, {} as never);
		await build().execute({ url: URL_A }, {} as never);
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(extractDocument).toHaveBeenCalledTimes(1);
	});

	it("never shares an entry across conversations or across users", async () => {
		pdf("v1");
		await turn();
		const otherConversation = { conversationId: new ObjectId(), userId: conv.userId };
		const otherUser = { conversationId: conv.conversationId, userId: new ObjectId() };
		const anonymous = { conversationId: conv.conversationId };
		await turn(otherConversation);
		await turn(otherUser);
		await turn(anonymous);
		expect(extractDocument).toHaveBeenCalledTimes(4);
		expect(await collections.webFetchCache.countDocuments({})).toBe(4);
		expect(await getCachedFetch(otherUser, URL_A)).toMatchObject({ userId: otherUser.userId });
	});

	it("is not served after its expiry even before the TTL monitor removes it", async () => {
		pdf("v1");
		await turn();
		const row = await collections.webFetchCache.findOne({});
		if (!row) throw new Error("no entry written");
		const days = (row.expiresAt.getTime() - row.fetchedAt.getTime()) / 86_400_000;
		expect(days).toBeCloseTo(DEFAULT_CACHE_DAYS, 3);
		await collections.webFetchCache.updateMany(
			{},
			{ $set: { expiresAt: new Date(Date.now() - 1) } }
		);
		expect(await getCachedFetch(conv, URL_A)).toBeNull();
		await turn();
		expect(extractDocument).toHaveBeenCalledTimes(2);
	});

	it("keeps a TTL index on expiresAt", async () => {
		const indexes = await collections.webFetchCache.indexes();
		expect(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
	});

	it("serves but does not keep a text over the per-entry cap, and drops the stale entry", async () => {
		pdf("v1");
		await turn();
		await setAge(conv, 11 * 60_000);
		pdf("v2");
		extractDocument.mockResolvedValue({
			ok: true,
			text: "x".repeat(MAX_ENTRY_CHARS + 1),
			pages: 1,
		});
		const result = await turn();
		expect("resultText" in result.result).toBe(true);
		expect(await collections.webFetchCache.countDocuments({})).toBe(0);
	});

	it("holds a conversation to its entry count and byte caps, oldest first", async () => {
		const entry = (n: number, text = "t") => ({
			finalUrl: `https://example.test/${n}`,
			title: null,
			text,
			contentHash: String(n),
			contentType: "text/html",
			extractedBy: "html" as const,
		});
		for (let n = 0; n < MAX_CONVERSATION_ENTRIES + 3; n++) {
			await putCachedFetch(conv, `https://example.test/${n}`, entry(n), new Date(1000 + n));
		}
		const urls = (
			await collections.webFetchCache.find({ conversationId: conv.conversationId }).toArray()
		).map((r) => r.url);
		expect(urls).toHaveLength(MAX_CONVERSATION_ENTRIES);
		expect(urls).not.toContain("https://example.test/0");
		expect(urls).toContain(`https://example.test/${MAX_CONVERSATION_ENTRIES + 2}`);

		await collections.webFetchCache.deleteMany({});
		const big = "y".repeat(MAX_ENTRY_CHARS);
		for (let n = 0; n < 12; n++) {
			await putCachedFetch(conv, `https://example.test/${n}`, entry(n, big), new Date(1000 + n));
		}
		const rows = await collections.webFetchCache.find({}).toArray();
		expect(rows.reduce((sum, r) => sum + r.textBytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(rows.map((r) => r.url)).toContain("https://example.test/11");
	});

	it("is deleted with the conversation, and only that conversation's entries", async () => {
		pdf("v1");
		await turn();
		const other = newScope();
		await turn(other);
		await deleteConversationStorage(conv.conversationId);
		const left = await collections.webFetchCache.find({}).toArray();
		expect(left.map((r) => r.conversationId.toString())).toEqual([other.conversationId.toString()]);
	});

	it("is erased with the account, by owner and by conversation", async () => {
		const gatewayUserId = "gw-fetch-cache";
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			gatewayUserId,
			username: "fetchcache",
			name: "Fetch Cache",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId,
			title: "c",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		pdf("v1");
		await turn({ conversationId, userId });
		await turn({ conversationId, userId: new ObjectId() }); // an entry the owner field misses
		const bystander = newScope();
		await turn(bystander);
		expect(await collections.webFetchCache.countDocuments({})).toBe(3);

		const { counts } = await runErasure("erasure-fetch-cache", gatewayUserId, []);
		expect(counts.webFetchCache).toBe(2);
		const left = await collections.webFetchCache.find({}).toArray();
		expect(left.map((r) => r.conversationId.toString())).toEqual([
			bystander.conversationId.toString(),
		]);
	});

	it("a cache failure never fails the fetch", async () => {
		pdf("v1");
		const spy = vi
			.spyOn(collections.webFetchCache, "findOne")
			.mockRejectedValue(new Error("db down"));
		const result = await turn();
		spy.mockRestore();
		expect("resultText" in result.result).toBe(true);
	});
});
