import { describe, it, expect } from "vitest";
import type { Message } from "$lib/types/Message";
import {
	MessageUpdateType,
	MessageToolUpdateType,
	MessageReasoningUpdateType,
	type MessageToolCallUpdate,
} from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";
import {
	collectReasoning,
	collectToolNames,
	exportConversationToMarkdown,
	exportFilename,
	formatToolNamesWithCounts,
	renderAnswerBody,
	slugifyTitle,
} from "./exportConversationMarkdown";

function userMessage(content: string, extra?: Partial<Message>): Message {
	return { id: "user-1", from: "user", content, ...extra };
}

function assistantMessage(content: string, extra?: Partial<Message>): Message {
	return { id: "assistant-1", from: "assistant", content, ...extra };
}

describe("slugifyTitle / exportFilename", () => {
	it("slugs titles for filenames", () => {
		expect(slugifyTitle("My Chat Title!")).toBe("my-chat-title");
		expect(slugifyTitle("  Café & crème  ")).toBe("cafe-creme");
		expect(slugifyTitle("")).toBe("conversation");
		expect(slugifyTitle("!!!")).toBe("conversation");
	});

	it("builds <slug>-<shortid>.md filenames", () => {
		expect(exportFilename("My Chat!", "abc123def456")).toBe("my-chat-def456.md");
		expect(exportFilename("", "abc123def456")).toBe("conversation-def456.md");
	});
});

describe("collectReasoning", () => {
	it("merges the reasoning field and inline <think> blocks", () => {
		const parts = collectReasoning(
			assistantMessage("<think>inline trace</think>answer", {
				reasoning: "server-side trace",
			})
		);
		expect(parts).toEqual(["server-side trace", "inline trace"]);
	});

	it("dedupes when the reasoning field repeats the <think> content", () => {
		const parts = collectReasoning(
			assistantMessage("<think>same trace</think>answer", { reasoning: "same trace" })
		);
		expect(parts).toEqual(["same trace"]);
	});

	it("collects an unterminated trailing block from a stopped run", () => {
		const parts = collectReasoning(assistantMessage("<think>cut off mid-trace"));
		expect(parts).toEqual(["cut off mid-trace"]);
	});

	it("returns nothing when there is no reasoning", () => {
		expect(collectReasoning(assistantMessage("plain answer"))).toEqual([]);
	});
});

describe("renderAnswerBody", () => {
	it("keeps code fences verbatim", () => {
		const body = renderAnswerBody('Here is code:\n```python\nprint("hi")\n```');
		expect(body).toBe('Here is code:\n```python\nprint("hi")\n```');
	});

	it("keeps direct-emission file blocks intact, title annotation included", () => {
		// A titled fence is ordinary message content; the export renders fences
		// as-is, so the language AND the title= annotation survive and the file
		// identity is preserved in the exported transcript.
		const body = renderAnswerBody(
			"Here is the report:\n```markdown title=report.md\n# Report\nAll quiet.\n```\nDone."
		);
		expect(body).toContain("```markdown title=report.md");
		expect(body).toContain("# Report\nAll quiet.");
	});

	it("removes <think> blocks (they belong in the reasoning section)", () => {
		expect(renderAnswerBody("<think>trace</think>visible")).toBe("visible");
	});

	it("renders artifact creates as fenced code with their language", () => {
		const body = renderAnswerBody(
			'Intro.\n<artifact identifier="app" type="code" language="python" title="App">print("hi")</artifact>\nOutro.'
		);
		expect(body).toContain("**Artifact: App (`app`)**");
		expect(body).toContain('```python\nprint("hi")\n```');
		expect(body).not.toContain("<artifact");
		expect(body).toContain("Intro.");
		expect(body).toContain("Outro.");
	});

	it("summarizes artifact updates instead of dumping diff pairs", () => {
		const body = renderAnswerBody(
			'<artifact identifier="app" type="update"><old_str>a</old_str><new_str>b</new_str></artifact>'
		);
		expect(body).toBe("_Edited artifact `app` (1 change)._");
	});

	it("keeps partial artifact content from a stopped run", () => {
		const body = renderAnswerBody(
			'Text.\n<artifact identifier="app" type="html" title="App"><h1>half'
		);
		expect(body).toContain("```html");
		expect(body).toContain("<h1>half");
	});
});

describe("collectToolNames", () => {
	it("lists every call in order, keeping duplicates", () => {
		const names = collectToolNames(
			assistantMessage("answer", {
				updates: [
					{
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Call,
						uuid: "u1",
						call: { name: "search", parameters: { q: "x" } },
					},
					{
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Result,
						uuid: "u1",
						result: {
							status: ToolResultStatus.Success,
							call: { name: "search", parameters: {} },
							outputs: [{ huge: "payload" }],
						},
					},
					{
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Call,
						uuid: "u2",
						call: { name: "search", parameters: { q: "y" } },
					},
					{
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Call,
						uuid: "u3",
						call: { name: "fetch", parameters: {} },
					},
				],
			})
		);
		// Results are not calls, but repeated calls are: five calls of one tool
		// must read as five, never collapse to the unique-name count.
		expect(names).toEqual(["search", "search", "fetch"]);
	});

	it("counts five calls of one tool as five", () => {
		const askCall = (i: number): MessageToolCallUpdate => ({
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Call,
			uuid: `u${i}`,
			call: { name: "ask_user_question", parameters: {} },
		});
		const names = collectToolNames(
			assistantMessage("answer", {
				updates: [0, 1, 2, 3, 4].map(askCall),
			})
		);
		expect(names).toEqual(Array(5).fill("ask_user_question"));
	});
});

describe("formatToolNamesWithCounts", () => {
	it("marks repeated names with ×N in first-call order", () => {
		expect(formatToolNamesWithCounts(["search", "search", "fetch"])).toEqual([
			"`search` ×2",
			"`fetch`",
		]);
		expect(formatToolNamesWithCounts(Array(5).fill("ask_user_question"))).toEqual([
			"`ask_user_question` ×5",
		]);
	});

	it("leaves single calls unmarked", () => {
		expect(formatToolNamesWithCounts(["read_pdf"])).toEqual(["`read_pdf`"]);
		expect(formatToolNamesWithCounts([])).toEqual([]);
	});
});

describe("exportConversationToMarkdown", () => {
	it("exports every turn of the visible branch with thinking before answers", () => {
		const md = exportConversationToMarkdown({
			title: "Deep question",
			conversationId: "abc123",
			model: "DeepSeek-R1",
			messages: [
				userMessage("What is 2+2?"),
				assistantMessage("<think>adding numbers</think>It is 4.", {
					id: "assistant-1",
					reasoning: "field trace",
				}),
				userMessage("And 3+3?"),
				assistantMessage("It is 6.", { id: "assistant-2" }),
			],
		});

		expect(md).toContain("# Deep question");
		const userIdx = md.indexOf("## User");
		const assistantIdx = md.indexOf("## Assistant (DeepSeek-R1)");
		expect(userIdx).toBeGreaterThan(-1);
		expect(assistantIdx).toBeGreaterThan(userIdx);

		// Reasoning first, as a collapsed section, then the answer.
		const thinkingIdx = md.indexOf("<details>\n<summary>Thinking</summary>");
		const answerIdx = md.indexOf("It is 4.");
		expect(thinkingIdx).toBeGreaterThan(assistantIdx);
		expect(answerIdx).toBeGreaterThan(thinkingIdx);
		expect(md).toContain("field trace");
		expect(md).toContain("adding numbers");
		// Raw <think> tags never leak into the file.
		expect(md).not.toContain("<think>");
		expect(md).toContain("It is 6.");
	});

	it("exports a stopped run faithfully: partial thinking, clamped answer, marker", () => {
		const md = exportConversationToMarkdown({
			title: "Stopped",
			conversationId: "abc123",
			messages: [
				userMessage("Write a long story"),
				assistantMessage("Once upon a <think>planning the plot", {
					id: "assistant-1",
					interrupted: true,
				}),
			],
		});
		expect(md).toContain("planning the plot");
		expect(md).toContain("Once upon a");
		expect(md).toContain("_Generation stopped._");
	});

	it("lists attachments by name, summarizes tools, excludes votes", () => {
		const md = exportConversationToMarkdown({
			title: "Files",
			conversationId: "abc123",
			messages: [
				userMessage("Read this", {
					files: [{ type: "hash", name: "report.pdf", value: "abc", mime: "application/pdf" }],
				}),
				assistantMessage("Done.", {
					id: "assistant-1",
					score: 1,
					updates: [
						{
							type: MessageUpdateType.Tool,
							subtype: MessageToolUpdateType.Call,
							uuid: "u1",
							call: { name: "read_pdf", parameters: { path: "/tmp/x" } },
						},
						{
							type: MessageUpdateType.Reasoning,
							subtype: MessageReasoningUpdateType.Status,
							status: "thinking",
						},
						{ type: MessageUpdateType.File, name: "output.csv", sha: "dead", mime: "text/csv" },
					],
				}),
			],
		});
		expect(md).toContain("- Attachment: report.pdf");
		expect(md).toContain("_Called 1 tool: `read_pdf`._");
		expect(md).toContain("- Generated file: output.csv");
		// No vote markers, no tool internals.
		expect(md).not.toContain("score");
		expect(md).not.toContain("/tmp/x");
	});

	it("counts tool calls, not unique names, with multiplicity", () => {
		const askCall = (uuid: string): MessageToolCallUpdate => ({
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Call,
			uuid,
			call: { name: "ask_user_question", parameters: {} },
		});
		const md = exportConversationToMarkdown({
			title: "Questions",
			conversationId: "abc123",
			messages: [
				userMessage("Do the thing"),
				assistantMessage("Here it is.", {
					id: "assistant-1",
					updates: ["u1", "u2", "u3", "u4", "u5"].map(askCall),
				}),
			],
		});
		expect(md).toContain("_Called 5 tools: `ask_user_question` ×5._");
	});

	it("lists mixed tools in first-call order with their counts", () => {
		const toolCall = (uuid: string, name: string): MessageToolCallUpdate => ({
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Call,
			uuid,
			call: { name, parameters: {} },
		});
		const md = exportConversationToMarkdown({
			title: "Mixed",
			conversationId: "abc123",
			messages: [
				userMessage("Research this"),
				assistantMessage("Done.", {
					id: "assistant-1",
					updates: [toolCall("u1", "search"), toolCall("u2", "fetch"), toolCall("u3", "search")],
				}),
			],
		});
		expect(md).toContain("_Called 3 tools: `search` ×2, `fetch`._");
	});

	it("skips system messages and keeps branch order", () => {
		const md = exportConversationToMarkdown({
			title: "Order",
			conversationId: "abc123",
			messages: [
				{ id: "s", from: "system", content: "preprompt" },
				userMessage("first"),
				assistantMessage("second", { id: "a" }),
				userMessage("third"),
			],
		});
		expect(md).not.toContain("preprompt");
		expect(md.indexOf("first") < md.indexOf("second")).toBe(true);
		expect(md.indexOf("second") < md.indexOf("third")).toBe(true);
	});

	it("falls back to untitled headings when title or model are absent", () => {
		const md = exportConversationToMarkdown({
			title: "",
			conversationId: "abc123",
			messages: [assistantMessage("hi", { id: "a" })],
		});
		expect(md).toContain("# Untitled conversation");
		expect(md).toContain("## Assistant\n");
	});
});
