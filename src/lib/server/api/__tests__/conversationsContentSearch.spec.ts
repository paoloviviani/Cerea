import { describe, expect, it, afterEach, beforeAll } from "vitest";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import {
	CONVERSATION_TEXT_INDEX_KEYS,
	CONVERSATION_TEXT_INDEX_OPTIONS,
} from "$lib/server/conversationTextIndex";
import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET } from "../../../../routes/api/v2/conversations/+server";

interface Row {
	title: string;
	snippet?: {
		text: string;
		spans: [number, number][];
		from: string;
		messageId: string;
	};
}

const msg = (id: string, from: "user" | "assistant", content: string) => ({
	id,
	from,
	content,
	createdAt: new Date(),
	updatedAt: new Date(),
});

async function search(locals: App.Locals, q: string, extra: Record<string, string> = {}) {
	const res = await testRequest(GET, {
		path: `/api/v2/conversations?${new URLSearchParams({ q, ...extra })}`,
		locals,
	});
	expect(res.status).toBe(200);
	return superjson.parse(await res.text()) as { conversations: Row[]; hasMore: boolean };
}

const withContent = { content: "1" };

beforeAll(async () => {
	await ready;
	// The app builds this in the background at startup; the test needs it now.
	await collections.conversations.createIndex(
		CONVERSATION_TEXT_INDEX_KEYS,
		CONVERSATION_TEXT_INDEX_OPTIONS
	);
}, 60000);

describe.sequential("GET /api/v2/conversations?q=&content=1", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it(
		"finds a chat by a word only in its messages, with a snippet",
		{ timeout: 30000 },
		async () => {
			const { locals } = await createTestUser();
			await createTestConversation(locals, {
				title: "Holiday plans",
				messages: [
					msg("m1", "user", "Where should we go?"),
					msg("m2", "assistant", "Consider **Lisbon** in spring, the light is lovely."),
				],
			});
			await createTestConversation(locals, {
				title: "Other",
				messages: [msg("m3", "user", "hello")],
			});

			const data = await search(locals, "lisbon", withContent);
			expect(data.conversations.map((c) => c.title)).toEqual(["Holiday plans"]);
			const snippet = data.conversations[0].snippet as NonNullable<Row["snippet"]>;
			expect(snippet.from).toBe("assistant");
			expect(snippet.messageId).toBe("m2");
			expect(snippet.text).not.toContain("**");
			const [start, end] = snippet.spans[0];
			expect(snippet.text.slice(start, end)).toBe("Lisbon");

			// Without the flag it is the title search only.
			expect((await search(locals, "lisbon")).conversations).toHaveLength(0);
		}
	);

	it("never returns another user's conversations", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		const { locals: other } = await createTestUser();
		await createTestConversation(other, {
			title: "Theirs",
			messages: [msg("m1", "user", "the zeppelin schedule")],
		});
		await createTestConversation(locals, {
			title: "Mine",
			messages: [msg("m2", "user", "a zeppelin sketch")],
		});

		const data = await search(locals, "zeppelin", withContent);
		expect(data.conversations.map((c) => c.title)).toEqual(["Mine"]);
	});

	it(
		"ranks title hits first, then content hits, without duplicates",
		{ timeout: 30000 },
		async () => {
			const { locals } = await createTestUser();
			const t = Date.now();
			await createTestConversation(locals, {
				title: "Plain talk",
				updatedAt: new Date(t),
				messages: [msg("a", "user", "the quasar again")],
			});
			await createTestConversation(locals, {
				title: "Quasar notes",
				updatedAt: new Date(t - 5000),
				messages: [msg("b", "user", "a quasar is bright")],
			});
			await createTestConversation(locals, {
				title: "Older quasar chat",
				updatedAt: new Date(t - 9000),
				messages: [],
			});
			await createTestConversation(locals, {
				title: "Dense",
				updatedAt: new Date(t - 20000),
				messages: [msg("c", "user", "quasar quasar quasar quasar")],
			});

			const data = await search(locals, "quasar", withContent);
			expect(data.conversations.map((c) => c.title)).toEqual([
				"Quasar notes",
				"Older quasar chat",
				"Dense",
				"Plain talk",
			]);
			// A title hit has no snippet; a content-only hit does.
			expect(data.conversations[0].snippet).toBeUndefined();
			expect(data.conversations[2].snippet).toBeDefined();
		}
	);

	it("ignores case and accents, and supports phrases", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, {
			title: "Fisco",
			messages: [msg("m1", "user", "Il mio Codice Fiscale è già stato inviato perché serve")],
		});
		await createTestConversation(locals, {
			title: "Altro",
			messages: [msg("m2", "user", "il fiscale ha un codice diverso")],
		});

		expect((await search(locals, "PERCHE", withContent)).conversations.map((c) => c.title)).toEqual(
			["Fisco"]
		);
		const phrase = await search(locals, '"codice fiscale"', withContent);
		expect(phrase.conversations.map((c) => c.title)).toEqual(["Fisco"]);
		const snippet = phrase.conversations[0].snippet as NonNullable<Row["snippet"]>;
		expect(snippet.text.slice(...snippet.spans[0])).toBe("Codice Fiscale");
		// Plain words must all be present.
		const both = await search(locals, "codice fiscale", withContent);
		expect(both.conversations.map((c) => c.title).sort()).toEqual(["Altro", "Fisco"]);
		expect((await search(locals, "codice inviato", withContent)).conversations).toHaveLength(1);
	});

	it("pages title hits then content hits", { timeout: 60000 }, async () => {
		const { locals } = await createTestUser();
		const t = Date.now();
		const total = CONV_NUM_PER_PAGE + 10;
		for (let i = 0; i < total; i++) {
			await createTestConversation(locals, {
				title: i < 5 ? `Marmot ${i}` : `Chat ${i}`,
				updatedAt: new Date(t - i * 1000),
				messages: [msg(`m${i}`, "user", "about the marmot")],
			});
		}
		const first = await search(locals, "marmot", withContent);
		expect(first.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(first.hasMore).toBe(true);
		expect(first.conversations.slice(0, 5).every((c) => c.title.startsWith("Marmot"))).toBe(true);
		const second = await search(locals, "marmot", { ...withContent, p: "1" });
		expect(second.conversations).toHaveLength(10);
		expect(second.hasMore).toBe(false);
		const titles = [...first.conversations, ...second.conversations].map((c) => c.title);
		expect(new Set(titles).size).toBe(total);
	});

	it(
		"does the title search only when the query has no whole word",
		{ timeout: 30000 },
		async () => {
			const { locals } = await createTestUser();
			await createTestConversation(locals, { title: "A day", messages: [msg("m1", "user", "x")] });
			await createTestConversation(locals, {
				title: "Other",
				messages: [msg("m2", "user", "a b x")],
			});
			const data = await search(locals, "x", withContent);
			expect(data.conversations).toHaveLength(0);
			const neg = await search(locals, "-hello", withContent);
			expect(neg.conversations).toHaveLength(0);
		}
	);

	it("matches whole words, not parts of longer ones", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, {
			title: "Words",
			messages: [msg("m1", "user", "a category of concatenated things")],
		});
		expect((await search(locals, "cat", withContent)).conversations).toHaveLength(0);
		expect((await search(locals, "art cat", withContent)).conversations).toHaveLength(0);
		expect((await search(locals, "category", withContent)).conversations).toHaveLength(1);
	});

	it("searches titles only for a visitor without an account", { timeout: 30000 }, async () => {
		const locals = createTestLocals({ sessionId: "visitor-session" });
		await createTestConversation(locals, {
			title: "Tamarind notes",
			messages: [msg("m1", "user", "the cardamom recipe")],
		});
		expect((await search(locals, "cardamom", withContent)).conversations).toHaveLength(0);
		expect((await search(locals, "tamarind", withContent)).conversations).toHaveLength(1);
	});

	it("drops one-letter words and stays fast on a huge chat", { timeout: 60000 }, async () => {
		const { locals } = await createTestUser();
		const messages = Array.from({ length: 2000 }, (_, i) =>
			msg(`m${i}`, i % 2 ? "assistant" : "user", `${"filler words go here ".repeat(50)} ${i}`)
		);
		messages.push(msg("end", "user", "the rare gorgonzola"));
		await createTestConversation(locals, { title: "Huge", messages });
		await createTestConversation(locals, {
			title: "Mini",
			messages: [msg("s", "user", "a gorgonzola pizza")],
		});

		const began = Date.now();
		const data = await search(locals, "gorgonzola", withContent);
		expect(Date.now() - began).toBeLessThan(5000);
		expect(data.conversations.map((c) => c.title).sort()).toEqual(["Huge", "Mini"]);
		// The 2,000th message is past what a snippet reads; the hit is still listed.
		expect(data.conversations.find((c) => c.title === "Huge")?.snippet).toBeUndefined();
		expect(data.conversations.find((c) => c.title === "Mini")?.snippet).toBeDefined();

		// "a" alone is not a word; "a gorgonzola" is searched as "gorgonzola".
		expect((await search(locals, "a", withContent)).conversations).toHaveLength(0);
		expect((await search(locals, "a gorgonzola", withContent)).conversations).toHaveLength(2);
	});
});
