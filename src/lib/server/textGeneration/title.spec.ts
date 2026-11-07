import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { Conversation } from "$lib/types/Conversation";

const mocks = vi.hoisted(() => ({
	generateFromDefaultEndpoint: vi.fn(),
	config: { LLM_SUMMARIZATION: "true", TASK_MODEL: "" } as Record<string, string | undefined> & {
		getSaved?: (k: string) => string | undefined;
	},
	saved: undefined as string | undefined,
	catalogue: [
		{ id: "test-model", name: "test-model", supportsReasoning: false },
		{ id: "reasoner", name: "reasoner", supportsReasoning: true },
		{ id: "plain", name: "plain", supportsReasoning: false },
	] as { id: string; name: string; supportsReasoning: boolean }[],
}));
mocks.config.getSaved = () => mocks.saved;
vi.mock("$lib/server/models", () => ({
	get models() {
		return mocks.catalogue;
	},
}));

vi.mock("$lib/server/config", () => ({ config: mocks.config }));
vi.mock("$lib/server/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("$lib/server/generateFromDefaultEndpoint", () => ({
	generateFromDefaultEndpoint: mocks.generateFromDefaultEndpoint,
}));

const { generateTitleForConversation, regenerateTitle } = await import("./title");

/** Endpoint stub: yields nothing, returns `text` as the generated title. */
function endpointReturning(text: string) {
	// eslint-disable-next-line require-yield
	return async function* () {
		return text;
	};
}

function newConversation(content: string, extra: Partial<Conversation> = {}): Conversation {
	return {
		_id: new ObjectId(),
		title: "New Chat",
		model: "test-model",
		messages: [{ id: "1" as Conversation["messages"][number]["id"], from: "user", content }],
		...extra,
	} as unknown as Conversation;
}

async function collect(conv: Conversation, opts?: { afterReply?: Promise<unknown> }) {
	const out: { title: string; source?: string; attempts?: number }[] = [];
	for await (const u of generateTitleForConversation(conv, undefined, opts)) {
		if (u.type === MessageUpdateType.Title) out.push(u);
	}
	return out;
}

/** Endpoint stub answering from a script, one entry per call. */
function endpointScript(...answers: string[]) {
	let n = 0;
	mocks.generateFromDefaultEndpoint.mockImplementation(
		// eslint-disable-next-line require-yield
		async function* () {
			return answers[Math.min(n++, answers.length - 1)];
		}
	);
}

async function titleFor(generated: string, userMessage = "how do I reverse a string in Python?") {
	mocks.generateFromDefaultEndpoint.mockImplementation(endpointReturning(generated));
	const updates = [];
	for await (const u of generateTitleForConversation(newConversation(userMessage), undefined)) {
		updates.push(u);
	}
	const titleUpdate = updates.find((u) => u.type === MessageUpdateType.Title);
	return titleUpdate && "title" in titleUpdate ? titleUpdate.title : undefined;
}

describe("generateTitleForConversation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.config.LLM_SUMMARIZATION = "true";
		mocks.config.TASK_MODEL = "";
		mocks.saved = undefined;
	});

	it("uses the model's title when it returns plain text", async () => {
		expect(await titleFor("Python string reversal")).toBe("Python string reversal");
	});

	it("drops a complete reasoning block and keeps the title after it", async () => {
		expect(await titleFor("<think>The user wants Python help.</think>Python string reversal")).toBe(
			"Python string reversal"
		);
	});

	it("falls back to a trimmed first sentence, never the reasoning trace", async () => {
		const title = await titleFor("<think>We need to produce a title. The user is asking");
		expect(title).not.toContain("We need to produce a title");
		expect(title).toBe("how do I reverse a string…");
	});

	it("marks a model title, and a fallback so a later turn may retry", async () => {
		endpointScript("Python string reversal");
		expect(await collect(newConversation("x"))).toEqual([
			expect.objectContaining({ title: "Python string reversal", source: "model", attempts: 1 }),
		]);
		endpointScript("");
		expect(await collect(newConversation("Cosa puoi fare per me?"))).toEqual([
			expect.objectContaining({ title: "Cosa puoi fare per me?", source: "fallback", attempts: 1 }),
		]);
	});

	it("answers a reasoning-only result with one larger budget, then falls back", async () => {
		endpointScript("<think>still thinking", "Python string reversal");
		const [update] = await collect(newConversation("how do I reverse a string in Python?"));
		expect(update).toMatchObject({ title: "Python string reversal", source: "model" });
		const budgets = mocks.generateFromDefaultEndpoint.mock.calls.map(
			(c) => (c[0] as { generateSettings: { max_tokens: number } }).generateSettings.max_tokens
		);
		expect(budgets).toEqual([64, 512]);
		expect(
			(mocks.generateFromDefaultEndpoint.mock.calls[0]?.[0] as { reasoningEffort: string })
				.reasoningEffort
		).toBe("low");
	});

	it("retries once the first reply is complete, showing the model the start of it", async () => {
		endpointScript("", "", "Giorni lavorativi in Italia");
		const conv = newConversation("Quanti giorni lavorativi ci sono in un anno in Italia");
		let finish!: () => void;
		const afterReply = new Promise<void>((r) => (finish = r));
		const done = collect(conv, { afterReply });
		await vi.waitFor(() => expect(mocks.generateFromDefaultEndpoint).toHaveBeenCalledTimes(2));
		// The first attempt (two token budgets) has fallen back; the reply is not in yet.
		conv.messages.push({
			id: "2",
			from: "assistant",
			content: "In Italia i giorni lavorativi sono circa 250 all'anno.",
		} as never);
		finish();
		const updates = await done;
		expect(updates.map((u) => [u.source, u.attempts])).toEqual([
			["fallback", 1],
			["model", 2],
		]);
		expect(updates[1]?.title).toBe("Giorni lavorativi in Italia");
		const last = mocks.generateFromDefaultEndpoint.mock.calls.at(-1)?.[0] as {
			messages: { content: string }[];
		};
		expect(last.messages[0]?.content).toContain("circa 250");
	});

	it("tries again on a later turn while the title is a fallback, up to three times", async () => {
		endpointScript("Python string reversal");
		const reply = { id: "2", from: "assistant", content: "Use slicing." } as never;
		const conv = newConversation("how do I reverse a string in Python?", {
			title: "how do I reverse a string…",
			titleSource: "fallback",
			titleAttempts: 2,
		});
		conv.messages.push(reply);
		expect(await collect(conv)).toEqual([
			expect.objectContaining({ title: "Python string reversal", source: "model", attempts: 3 }),
		]);

		mocks.generateFromDefaultEndpoint.mockClear();
		const spent = newConversation("x", { title: "x", titleSource: "fallback", titleAttempts: 3 });
		expect(await collect(spent)).toEqual([]);
		expect(mocks.generateFromDefaultEndpoint).not.toHaveBeenCalled();
	});

	it("keeps the shown title when a retry also fails", async () => {
		endpointScript("");
		const conv = newConversation("hello there", {
			title: "hello there",
			titleSource: "fallback",
			titleAttempts: 1,
		});
		expect(await collect(conv)).toEqual([
			expect.objectContaining({ title: "hello there", source: "fallback", attempts: 2 }),
		]);
	});

	it("never touches a title the user typed, nor a model title", async () => {
		endpointScript("Something else");
		expect(
			await collect(newConversation("x", { title: "My rename", titleSource: "user" }))
		).toEqual([]);
		expect(await collect(newConversation("x", { title: "Named", titleSource: "model" }))).toEqual(
			[]
		);
		expect(await collect(newConversation("x", { title: "Old chat but not New Chat" }))).toEqual([]);
		expect(mocks.generateFromDefaultEndpoint).not.toHaveBeenCalled();
	});

	it("uses the administrator's model, then TASK_MODEL, for titles", async () => {
		endpointScript("A title");
		mocks.config.TASK_MODEL = "task-one";
		mocks.saved = "plain";
		await collect(newConversation("hello"));
		expect(
			(mocks.generateFromDefaultEndpoint.mock.calls[0]?.[0] as { modelId: string }).modelId
		).toBe("plain");
		mocks.saved = undefined;
		await collect(newConversation("hello"));
		expect(
			(mocks.generateFromDefaultEndpoint.mock.calls[1]?.[0] as { modelId: string }).modelId
		).toBe("task-one");
	});

	it("automatic prefers a non-reasoning model over a reasoning conversation model", async () => {
		endpointScript("A title");
		await collect(newConversation("hello", { model: "reasoner" }));
		expect(
			(mocks.generateFromDefaultEndpoint.mock.calls[0]?.[0] as { modelId: string }).modelId
		).toBe("test-model");
		await collect(newConversation("hello", { model: "plain" }));
		expect(
			(mocks.generateFromDefaultEndpoint.mock.calls[1]?.[0] as { modelId: string }).modelId
		).toBe("plain");
	});

	it("asks for the user's language", async () => {
		await titleFor("x");
		const args = mocks.generateFromDefaultEndpoint.mock.calls[0]?.[0] as { preprompt: string };
		expect(args.preprompt).toContain("language of the user's message");
	});

	it("makes no model call when summarization is off", async () => {
		mocks.config.LLM_SUMMARIZATION = "false";
		expect(await collect(newConversation("Cosa puoi fare per me?"))).toEqual([
			expect.objectContaining({ title: "Cosa puoi fare per me?" }),
		]);
		expect(mocks.generateFromDefaultEndpoint).not.toHaveBeenCalled();
	});
});

describe("regenerateTitle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.config.LLM_SUMMARIZATION = "true";
		mocks.config.TASK_MODEL = "";
		mocks.saved = undefined;
	});

	it("never replaces a title the user typed, and does not call the model", async () => {
		endpointScript("Something else");
		const result = await regenerateTitle(
			newConversation("x", { title: "My rename", titleSource: "user" }),
			undefined
		);
		expect(result).toEqual({ ok: false, reason: "user-title" });
		expect(mocks.generateFromDefaultEndpoint).not.toHaveBeenCalled();
	});

	it("replaces a model's or a fallback's title, showing the model the start of the reply", async () => {
		endpointScript("Better title");
		const conv = newConversation("reverse a string", {
			title: "reverse a string",
			titleSource: "model",
		});
		conv.messages.push({
			id: "2" as Conversation["messages"][number]["id"],
			from: "assistant",
			content: "Use slicing: s[::-1].",
		} as Conversation["messages"][number]);
		expect(await regenerateTitle(conv, undefined)).toEqual({ ok: true, title: "Better title" });
		const prompt = JSON.stringify(mocks.generateFromDefaultEndpoint.mock.calls[0]?.[0]);
		expect(prompt).toContain("s[::-1]");

		endpointScript("Another");
		const fallback = newConversation("hi", {
			title: "hi",
			titleSource: "fallback",
			titleAttempts: 3,
		});
		expect(await regenerateTitle(fallback, undefined)).toEqual({ ok: true, title: "Another" });
	});

	it("says it could not, and keeps the title, when the model gives nothing or summarising is off", async () => {
		endpointScript("");
		expect(await regenerateTitle(newConversation("x", { title: "x" }), undefined)).toEqual({
			ok: false,
			reason: "unavailable",
		});
		mocks.config.LLM_SUMMARIZATION = "false";
		endpointScript("A title");
		expect(await regenerateTitle(newConversation("x", { title: "x" }), undefined)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("needs a first message to title", async () => {
		const conv = newConversation("x");
		conv.messages = [];
		expect(await regenerateTitle(conv, undefined)).toEqual({ ok: false, reason: "no-messages" });
	});
});
