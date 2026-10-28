import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
	MAX_IMAGES_PER_TURN,
	PICTURES_REMOVED,
	isPictureMessage,
	pictureMessages,
	withoutOlderPictures,
} from "./pictureMessages";

const shot = (n: number) =>
	pictureMessages([
		{
			id: `c${n}`,
			name: "look_doc",
			subject: `deck.pptx, slide ${n}`,
			images: [{ mime: "image/png", base64: "QQ==", label: `slide ${n}` }],
		},
	]);

describe("pictureMessages", () => {
	it("is one user message, with no assistant bridge", () => {
		const out = shot(1);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
		expect(isPictureMessage(out[0])).toBe(true);
		expect(isPictureMessage({ role: "user", content: "hello" })).toBe(false);
		expect(isPictureMessage({ role: "assistant", content: "(looking at the pages)" })).toBe(false);
	});

	it("puts the pictures straight after the tool messages: tool, user (the order tried live)", () => {
		const request: ChatCompletionMessageParam[] = [
			{ role: "system", content: "s" },
			{ role: "user", content: "check my deck" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "look_doc", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
			...shot(1),
			{ role: "assistant", content: "looks fine" },
		];
		expect(request.slice(2).map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
		expect(request.slice(-3, -1).map((m) => m.role)).toEqual(["tool", "user"]);
	});
});

describe("withoutOlderPictures", () => {
	it("replaces picture messages with a one-line note and leaves everything else", () => {
		const messages: ChatCompletionMessageParam[] = [
			{ role: "user", content: "hi" },
			...shot(1),
			{ role: "tool", tool_call_id: "x", content: "t" },
		];
		const out = withoutOlderPictures(messages);
		expect(out[1]).toEqual({ role: "user", content: PICTURES_REMOVED });
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
		expect(PICTURES_REMOVED).toBe(
			"[images from an earlier look_doc call removed; call look_doc again if you need them]"
		);
	});
});

describe("the per-turn cap", () => {
	it("is 18", () => {
		expect(MAX_IMAGES_PER_TURN).toBe(18);
	});
});
