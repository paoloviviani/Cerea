import { describe, expect, it } from "vitest";
import { applyUpdateToMessage, joinStepText, startsNewStepSegment } from "./applyUpdate";
import {
	MessageReasoningUpdateType,
	MessageToolUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageStreamUpdate,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";

const message = (over: Partial<Message> = {}): Message =>
	({
		id: "m1",
		from: "assistant",
		content: "",
		updates: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...over,
	}) as Message;

const ctx = (m: Message, initialContent = "", isRouterModel = false) => ({
	message: m,
	conv: { title: "New Chat" },
	initialContent,
	isRouterModel,
});

const toolCall: MessageUpdate = {
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid: "t1",
	call: { name: "hf_jobs", parameters: {} },
};

const stream = (token: string): MessageStreamUpdate => ({
	type: MessageUpdateType.Stream,
	token,
});

describe("applyUpdateToMessage", () => {
	it("drops an empty stream token entirely", () => {
		// Not merely ignored for content: it must reach neither the updates array
		// nor, by the caller's contract, the log or the client.
		const m = message();
		const applied = applyUpdateToMessage({ type: MessageUpdateType.Stream, token: "" }, ctx(m));

		expect(applied.skipped).toBe(true);
		expect(m.updates).toHaveLength(0);
		expect(m.content).toBe("");
	});

	it("accumulates stream tokens and reasoning separately", () => {
		const m = message();
		applyUpdateToMessage({ type: MessageUpdateType.Stream, token: "he" }, ctx(m));
		applyUpdateToMessage({ type: MessageUpdateType.Stream, token: "llo" }, ctx(m));
		applyUpdateToMessage(
			{
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: "hmm",
			},
			ctx(m)
		);

		expect(m.content).toBe("hello");
		expect(m.reasoning).toBe("hmm");
	});

	it("strips think markers from a title and reports the change", () => {
		const m = message();
		const c = ctx(m);
		const applied = applyUpdateToMessage(
			{ type: MessageUpdateType.Title, title: "<think>Python string reversal</think>" },
			c
		);

		expect(applied.titleChanged).toBe(true);
		expect(c.conv.title).toBe("Python string reversal");
	});

	it("replaces streamed text with the final answer when no tool ran", () => {
		const m = message({ content: "partial" });
		applyUpdateToMessage(
			{ type: MessageUpdateType.FinalAnswer, text: "the answer", interrupted: false },
			ctx(m)
		);

		expect(m.content).toBe("the answer");
	});

	describe("merging a final answer with pre-tool content", () => {
		// Providers stream text, call a tool, then answer with something else. The
		// pre-tool text is the user's, not a draft to be overwritten.
		it("A: keeps what was streamed when the final text repeats it", () => {
			const m = message({ content: "a story", updates: [toolCall] });
			applyUpdateToMessage(
				{ type: MessageUpdateType.FinalAnswer, text: "story", interrupted: false },
				ctx(m)
			);

			expect(m.content).toBe("a story");
		});

		it("B: uses the final text verbatim when it already contains the prefix", () => {
			const m = message({ content: "a story", updates: [toolCall] });
			applyUpdateToMessage(
				{ type: MessageUpdateType.FinalAnswer, text: "a story and more", interrupted: false },
				ctx(m)
			);

			expect(m.content).toBe("a story and more");
		});

		it("C: joins them with a paragraph break otherwise", () => {
			const m = message({ content: "a story", updates: [toolCall] });
			applyUpdateToMessage(
				{ type: MessageUpdateType.FinalAnswer, text: "a caption", interrupted: false },
				ctx(m)
			);

			expect(m.content).toBe("a story\n\na caption");
		});

		it("does not add a second gap when one is already there", () => {
			const m = message({ content: "a story\n\n", updates: [toolCall] });
			applyUpdateToMessage(
				{ type: MessageUpdateType.FinalAnswer, text: "a caption", interrupted: false },
				ctx(m)
			);

			expect(m.content).toBe("a story\n\na caption");
		});
	});

	it("leaves content from earlier rounds of the same message alone", () => {
		// The case a resumed turn depends on: the message already says something,
		// and this turn's final answer replaces only what this turn produced.
		const m = message({ content: "earlier work. new bit", updates: [toolCall] });
		applyUpdateToMessage(
			{ type: MessageUpdateType.FinalAnswer, text: "conclusion", interrupted: false },
			ctx(m, "earlier work. ")
		);

		expect(m.content).toBe("earlier work. new bit\n\nconclusion");
	});

	it("records the interrupted flag", () => {
		const m = message();
		applyUpdateToMessage(
			{ type: MessageUpdateType.FinalAnswer, text: "cut short", interrupted: true },
			ctx(m)
		);

		expect(m.interrupted).toBe(true);
	});

	it("keeps keepalives out of the updates array", () => {
		const m = message();
		applyUpdateToMessage(
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.KeepAlive },
			ctx(m)
		);

		expect(m.updates).toHaveLength(0);
	});

	it("merges router metadata for a router model and provider alone otherwise", () => {
		const router = message();
		applyUpdateToMessage(
			{ type: MessageUpdateType.RouterMetadata, route: "omni", model: "big" },
			ctx(router, "", true)
		);
		applyUpdateToMessage(
			{ type: MessageUpdateType.RouterMetadata, route: "", model: "", provider: "together" },
			ctx(router, "", true)
		);
		expect(router.routerMetadata).toEqual({ route: "omni", model: "big", provider: "together" });

		const plain = message();
		applyUpdateToMessage(
			{
				type: MessageUpdateType.RouterMetadata,
				route: "ignored",
				model: "ignored",
				provider: "hf-inference",
			},
			ctx(plain, "", false)
		);
		expect(plain.routerMetadata).toEqual({ route: "", model: "", provider: "hf-inference" });
	});
});

describe("joinStepText", () => {
	it("puts a paragraph break between two non-empty segments", () => {
		expect(joinStepText("play with trails.", "That one's on me.")).toBe(
			"play with trails.\n\nThat one's on me."
		);
	});

	it("adds no break when either segment is empty", () => {
		expect(joinStepText("", "That one's on me.")).toBe("That one's on me.");
		expect(joinStepText("play with trails.", "")).toBe("play with trails.");
		expect(joinStepText("play with trails.", "   ")).toBe("play with trails.   ");
	});

	it("adds no break when the boundary already has one", () => {
		expect(joinStepText("play with trails.\n\n", "That one's on me.")).toBe(
			"play with trails.\n\nThat one's on me."
		);
		expect(joinStepText("play with trails.", "\nThat one's on me.")).toBe(
			"play with trails.\nThat one's on me."
		);
	});

	it("treats pure-reasoning segments as empty", () => {
		// A step that only thought (or a message holding only thought) is not a
		// text segment, so no break is owed on either side of it.
		expect(joinStepText("<think>drafting the artifact</think>", "Here it is.")).toBe(
			"<think>drafting the artifact</think>Here it is."
		);
		expect(joinStepText("play with trails.", "<think>weighing options</think>")).toBe(
			"play with trails.<think>weighing options</think>"
		);
	});
});

describe("startsNewStepSegment", () => {
	it("is false with no history or with visible text since any tool", () => {
		expect(startsNewStepSegment(undefined)).toBe(false);
		expect(startsNewStepSegment([])).toBe(false);
		expect(startsNewStepSegment([stream("hello")])).toBe(false);
		expect(startsNewStepSegment([stream("a"), toolCall, stream("b")])).toBe(false);
	});

	it("is true when a tool ran since the last visible stream", () => {
		expect(startsNewStepSegment([stream("a"), toolCall])).toBe(true);
	});

	it("skips pure-reasoning chunks on both sides of the boundary", () => {
		// The step thought before speaking: the think chunks are not segments.
		expect(startsNewStepSegment([stream("a"), toolCall, stream("<think>hmm")])).toBe(true);
		expect(
			startsNewStepSegment([stream("<think>draft</think>"), toolCall, stream("<think>hmm")])
		).toBe(true);
	});
});

describe("streaming a new step after tools", () => {
	it("separates consecutive steps' text, in content and in the forwarded token", () => {
		const m = message();
		applyUpdateToMessage(stream("play with trails."), ctx(m));
		applyUpdateToMessage(toolCall, ctx(m));
		const second = stream("That one's on me.");
		applyUpdateToMessage(second, ctx(m));

		expect(m.content).toBe("play with trails.\n\nThat one's on me.");
		// The break rides on the token itself, so the SSE client, the
		// generation-event writer and the persisted updates all read the same
		// bytes as the export does.
		expect(second.token).toBe("\n\nThat one's on me.");
		const stored = m.updates?.at(-1);
		expect(stored?.type).toBe(MessageUpdateType.Stream);
		if (stored?.type === MessageUpdateType.Stream) expect(stored.token).toBe(second.token);
	});

	it("streams incrementally within a step: later chunks are untouched", () => {
		const m = message();
		applyUpdateToMessage(stream("play with "), ctx(m));
		applyUpdateToMessage(stream("trails."), ctx(m));
		applyUpdateToMessage(toolCall, ctx(m));
		applyUpdateToMessage(stream("That "), ctx(m));
		applyUpdateToMessage(stream("one's on me."), ctx(m));

		expect(m.content).toBe("play with trails.\n\nThat one's on me.");
	});

	it("adds no leading break when the turn had no text before the tools", () => {
		const m = message();
		applyUpdateToMessage(toolCall, ctx(m));
		applyUpdateToMessage(stream("That one's on me."), ctx(m));

		expect(m.content).toBe("That one's on me.");
	});

	it("adds no break when the prior step is reasoning-only", () => {
		const m = message();
		applyUpdateToMessage(stream("<think>drafting the artifact</think>"), ctx(m));
		applyUpdateToMessage(toolCall, ctx(m));
		applyUpdateToMessage(stream("Here it is."), ctx(m));

		expect(m.content).toBe("<think>drafting the artifact</think>Here it is.");
	});

	it("never doubles a break the step already carries", () => {
		const m = message();
		applyUpdateToMessage(stream("play with trails.\n\n"), ctx(m));
		applyUpdateToMessage(toolCall, ctx(m));
		applyUpdateToMessage(stream("That one's on me."), ctx(m));

		expect(m.content).toBe("play with trails.\n\nThat one's on me.");
	});

	it("puts the break after the think markup when the step opens with reasoning", () => {
		const m = message();
		applyUpdateToMessage(stream("play with trails.<think>weighing options"), ctx(m));
		applyUpdateToMessage(toolCall, ctx(m));
		applyUpdateToMessage(stream("</think>That one's on me."), ctx(m));

		expect(m.content).toBe("play with trails.<think>weighing options</think>\n\nThat one's on me.");
	});
});
