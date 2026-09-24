import { describe, expect, it } from "vitest";
import type { Message, Part, Transcript } from "$lib/types/machineProtocol";
import { HANDOFF_HISTORY_CHAR_CAP, buildHandoffHistory } from "./handoff";

function userMessage(id: string): Message {
	return { id, role: "user", createdAt: new Date().toISOString() };
}

function assistantMessage(id: string): Message {
	return { id, role: "assistant", createdAt: new Date().toISOString() };
}

function textPart(id: string, messageId: string, role: string, text: string): Part {
	return { id, messageId, role, type: "text", text };
}

function toolPart(
	id: string,
	messageId: string,
	overrides: Partial<Extract<Part, { type: "tool" }>> = {}
): Part {
	return {
		id,
		messageId,
		role: "assistant",
		type: "tool",
		callId: `call-${id}`,
		tool: "bash",
		status: "completed",
		input: { command: "ls" },
		output: "file.txt",
		...overrides,
	};
}

describe("buildHandoffHistory", () => {
	it("renders user and assistant text under role headings", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: userMessage("m1"),
					parts: [textPart("p1", "m1", "user", "please refactor this")],
				},
				{ message: assistantMessage("m2"), parts: [textPart("p2", "m2", "assistant", "on it")] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown, truncated } = buildHandoffHistory(transcript);
		expect(truncated).toBe(false);
		expect(markdown).toBe("**User:**\nplease refactor this\n\n**Assistant:**\non it");
	});

	it("renders one line per tool call, with the tool name and a short input/output summary", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m1"),
					parts: [
						toolPart("p1", "m1", {
							tool: "bash",
							input: { command: "ls -la" },
							output: "a.txt\nb.txt",
						}),
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown } = buildHandoffHistory(transcript);
		expect(markdown).toBe('**Assistant:**\n- `bash`({"command":"ls -la"}) → a.txt b.txt');
	});

	it("summarizes a failed tool call by its error, not its output", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m1"),
					parts: [
						toolPart("p1", "m1", {
							status: "error",
							error: "permission denied",
							output: undefined,
						}),
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown } = buildHandoffHistory(transcript);
		expect(markdown).toContain("error: permission denied");
	});

	it("excludes synthetic and empty text parts", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m1"),
					parts: [
						textPart("p1", "m1", "assistant", ""),
						{ ...textPart("p2", "m1", "assistant", "hidden"), synthetic: true } as Part,
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown } = buildHandoffHistory(transcript);
		expect(markdown).toBe("");
	});

	it("stops at uptoMessageId, excluding later messages", () => {
		const transcript: Transcript = {
			messages: [
				{ message: userMessage("m1"), parts: [textPart("p1", "m1", "user", "first")] },
				{ message: assistantMessage("m2"), parts: [textPart("p2", "m2", "assistant", "second")] },
				{
					message: userMessage("m3"),
					parts: [textPart("p3", "m3", "user", "third — after the boundary")],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown } = buildHandoffHistory(transcript, "m2");
		expect(markdown).not.toContain("third");
		expect(markdown).toBe("**User:**\nfirst\n\n**Assistant:**\nsecond");
	});

	it("carries the rest of the boundary's turn: opencode writes one assistant message per step", () => {
		const transcript: Transcript = {
			messages: [
				{ message: userMessage("m1"), parts: [textPart("p1", "m1", "user", "first")] },
				{ message: assistantMessage("m2"), parts: [textPart("p2", "m2", "assistant", "step one")] },
				{ message: assistantMessage("m3"), parts: [textPart("p3", "m3", "assistant", "step two")] },
				{ message: userMessage("m4"), parts: [textPart("p4", "m4", "user", "next turn")] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown } = buildHandoffHistory(transcript, "m2");
		expect(markdown).toContain("step two");
		expect(markdown).not.toContain("next turn");
	});

	it("caps the result at 200k characters and notes the truncation inside the text", () => {
		const huge = "x".repeat(HANDOFF_HISTORY_CHAR_CAP + 5000);
		const transcript: Transcript = {
			messages: [{ message: userMessage("m1"), parts: [textPart("p1", "m1", "user", huge)] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown, truncated } = buildHandoffHistory(transcript);
		expect(truncated).toBe(true);
		expect(markdown.length).toBeLessThanOrEqual(HANDOFF_HISTORY_CHAR_CAP);
		expect(markdown).toContain("truncated at 200,000 characters");
	});

	it("does not truncate a transcript at or under the cap", () => {
		const atCap = "x".repeat(HANDOFF_HISTORY_CHAR_CAP - "**User:**\n".length);
		const transcript: Transcript = {
			messages: [{ message: userMessage("m1"), parts: [textPart("p1", "m1", "user", atCap)] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const { markdown, truncated } = buildHandoffHistory(transcript);
		expect(truncated).toBe(false);
		expect(markdown.length).toBe(HANDOFF_HISTORY_CHAR_CAP);
	});
});
