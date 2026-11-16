import { describe, expect, it } from "vitest";
import {
	FALLBACK_LARGE_CONTENT_CHARS,
	FALLBACK_LARGE_PROSE_CHARS,
	PROSE_SAMPLE_TAIL_CHARS,
	classifyContent,
	SAMPLE_HEAD_CHARS,
	SAMPLE_TAIL_CHARS,
	countLines,
	largeContentBlock,
	largeContentThresholdChars,
	pickLargest,
	sampleOf,
} from "./largeContent";
import { prepareMessagesWithFiles } from "./prepareFiles";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";
import type { makeImageProcessor } from "$lib/server/endpoints/images";

const imageProcessor = (() => {
	throw new Error("no images here");
}) as unknown as ReturnType<typeof makeImageProcessor>;

describe("the threshold", () => {
	it("is 25% of the window in tokens, at 4 characters a token", () => {
		expect(largeContentThresholdChars(100_000)).toBe(100_000);
		expect(largeContentThresholdChars(8_000)).toBe(8_000);
	});

	it("is 25% of the fallback budget when the window is unknown", () => {
		expect(largeContentThresholdChars(undefined)).toBe(FALLBACK_LARGE_CONTENT_CHARS);
		expect(largeContentThresholdChars(0)).toBe(FALLBACK_LARGE_CONTENT_CHARS);
		expect(FALLBACK_LARGE_CONTENT_CHARS).toBe(400_000 * 0.25);
	});
});

describe("the prose threshold", () => {
	it("is higher than the data one when the window is unknown", () => {
		expect(largeContentThresholdChars(undefined, "prose")).toBe(FALLBACK_LARGE_PROSE_CHARS);
		expect(FALLBACK_LARGE_PROSE_CHARS).toBe(200_000);
		expect(largeContentThresholdChars(undefined, "data")).toBe(FALLBACK_LARGE_CONTENT_CHARS);
		expect(largeContentThresholdChars(undefined, "unknown")).toBe(FALLBACK_LARGE_CONTENT_CHARS);
	});

	it("is the same for every class when the window is known", () => {
		expect(largeContentThresholdChars(100_000, "prose")).toBe(100_000);
	});
});

const transcript = Array.from(
	{ length: 600 },
	(_, i) =>
		`## ${i % 2 ? "Assistant" : "User"}\n\nThis is message number ${i}. It talks about presets and LUTs for a grade.\n`
).join("\n");

describe("classifying a content", () => {
	const kind = (name: string, text: string, mime = "text/plain") =>
		classifyContent({ name, mime, text });

	it("calls a markdown chat export prose", () => {
		expect(transcript.length).toBeGreaterThan(100_000 / 2);
		expect(kind("lightroom-presets-luts-dc7db3.md", transcript, "text/markdown")).toBe("prose");
		expect(kind("export", transcript)).toBe("prose");
	});

	it("calls extracted document text prose", () => {
		const text =
			"Quarterly review.\nThe team shipped three features this quarter.\nNext we plan more.";
		expect(kind("report.docx", text, "text/markdown")).toBe("prose");
		expect(kind("deck.pdf", text)).toBe("prose");
		expect(kind("notes.txt", text)).toBe("prose");
	});

	it("calls data by extension", () => {
		for (const name of [
			"a.json",
			"a.jsonl",
			"a.ndjson",
			"a.csv",
			"a.tsv",
			"a.log",
			"a.xml",
			"a.yaml",
			"a.sql",
		])
			expect(kind(name, "whatever")).toBe("data");
	});

	it("calls delimited lines data", () => {
		expect(kind("table.txt", "a,b,c\n1,2,3\n4,5,6\n7,8,9")).toBe("data");
	});

	it("calls a log data", () => {
		expect(kind("server.log", "2026-01-01 INFO started\n2026-01-01 WARN slow")).toBe("data");
	});

	it("calls a paste that starts with { or [ data", () => {
		expect(kind("pasted-1.txt", '  {"a": 1}', "application/vnd.chatui.clipboard")).toBe("data");
		expect(kind("pasted-2.txt", "[1, 2, 3]", "application/vnd.chatui.clipboard")).toBe("data");
	});

	it("calls the rest unknown", () => {
		expect(kind("main.rs", "fn main() {}", "text/x-rust")).toBe("unknown");
		expect(kind("notes.txt", "xkcd qwerty\nasdf")).toBe("unknown");
	});
});

describe("which content becomes a pointer", () => {
	it("is none when everything fits", () => {
		expect(pickLargest([40_000, 50_000], 100_000).size).toBe(0);
	});

	it("is the largest first, and stops once the rest fit", () => {
		expect([...pickLargest([30_000, 90_000, 20_000], 100_000)]).toEqual([1]);
	});

	it("takes more than one when the largest alone is not enough", () => {
		expect([...pickLargest([90_000, 80_000, 70_000], 100_000)].sort()).toEqual([0, 1]);
	});

	it("never points at a content a pointer would not shrink", () => {
		expect(pickLargest([2_000, 3_000], 1_000).size).toBe(0);
	});
});

describe("the sample", () => {
	it("cuts the start and the end at line ends", () => {
		const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const { head, tail } = sampleOf(lines.join("\n"));
		expect(head.length).toBeLessThanOrEqual(SAMPLE_HEAD_CHARS);
		expect(head.startsWith("line 0\nline 1")).toBe(true);
		expect(head.split("\n").at(-1)).toMatch(/^line \d+$/);
		expect(lines).toContain(head.split("\n").at(-1));
		expect(tail.length).toBeLessThanOrEqual(SAMPLE_TAIL_CHARS);
		expect(tail.split("\n")[0]).toMatch(/^line \d+$/);
		expect(tail.endsWith("line 1999")).toBe(true);
		expect(lines).toContain(tail.split("\n")[0]);
	});

	it("falls back to the character count for one huge line", () => {
		const { head, tail } = sampleOf("x".repeat(100_000));
		expect(head.length).toBe(SAMPLE_HEAD_CHARS);
		expect(tail.length).toBe(SAMPLE_TAIL_CHARS);
	});

	it("counts lines without counting a final newline", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a")).toBe(1);
		expect(countLines("a\nb\n")).toBe(2);
		expect(countLines("a\n\nb")).toBe(3);
	});
});

const big = Array.from({ length: 5000 }, (_, i) => `{"id": ${i}}`).join("\n");

describe("the note", () => {
	const block = (over: Partial<Parameters<typeof largeContentBlock>[0]> = {}) =>
		largeContentBlock({
			name: "data.json",
			mime: "application/json",
			text: big,
			mountName: "data.json",
			codeToolOffered: true,
			delegateToolOffered: false,
			...over,
		});

	it("names the size and lines, shows a sample, and points at the file", () => {
		const out = block();
		expect(out).toContain('<document name="data.json" type="application/json">');
		expect(out).toContain("5000 lines");
		expect(out).toContain('Start:\n{"id": 0}');
		expect(out).toContain("[... omitted ...]");
		expect(out).toContain("End:\n");
		expect(out).toContain("The full content is at /mnt/data/data.json.");
		expect(out).toContain("execute_code");
		expect(out).toContain("never print it whole");
		expect(out).toContain("ask the user first whether to read it in chunks");
		expect(out).not.toContain(big);
	});

	it("reads chunk by chunk with code when there is no delegate tool", () => {
		const out = block();
		expect(out).toContain("read it chunk by chunk, keeping running notes");
		expect(out).not.toContain("sub-agent");
	});

	it("dispatches sub-agents when the delegate tool is offered", () => {
		const out = block({ delegateToolOffered: true });
		expect(out).toContain("one sub-agent per chunk with the delegate tool, one after another");
		expect(out).toContain(
			"the user's instruction first, then your running notes so far, then its chunk"
		);
	});

	it("points at the extracted text and the original for a document", () => {
		const out = block({ name: "r.pdf", mountName: "r.pdf", mountTextName: "r.pdf.md" });
		expect(out).toContain(
			"The full extracted text is at /mnt/data/r.pdf.md (the original file is at /mnt/data/r.pdf)."
		);
	});

	it("tells data to be queried with code, in the unchanged note", () => {
		const out = block();
		expect(out).toContain(
			"Read it with code (execute_code) only as far as you need. Structured data (JSON, CSV, logs)"
		);
		expect(out).not.toContain("not data to parse");
	});

	it("tells prose to be read, not parsed, with the resume path", () => {
		const out = block({
			name: "chat.md",
			mime: "text/markdown",
			mountName: "chat.md",
			text: transcript,
		});
		expect(out).toContain("a document or text to read, not data to parse");
		expect(out).toContain("Do not run code on it unless the user asks for something computational");
		expect(out).toContain("answer from the sample above");
		expect(out).toContain("ask the user what they want to pick up");
		expect(out).toContain("ask the user first whether to read it in chunks");
		expect(out).not.toContain("Structured data");
		expect(out).not.toContain("sub-agent");
		const withDelegate = block({
			name: "chat.md",
			mime: "text/markdown",
			mountName: "chat.md",
			text: transcript,
			delegateToolOffered: true,
		});
		expect(withDelegate).toContain("one sub-agent per chunk");
	});

	it("shows prose a longer end than data", () => {
		const prose = block({
			name: "chat.md",
			mime: "text/markdown",
			mountName: "chat.md",
			text: transcript,
		});
		const end = prose.split("End:\n")[1].split("\nThe full")[0];
		expect(end.length).toBeGreaterThan(1_000);
		expect(end.length).toBeLessThanOrEqual(PROSE_SAMPLE_TAIL_CHARS);
		expect(sampleOf(big).tail.length).toBeLessThanOrEqual(SAMPLE_TAIL_CHARS);
	});

	it("gives an unknown content a neutral note", () => {
		const out = block({
			name: "main.rs",
			mime: "text/x-rust",
			mountName: "main.rs",
			text: "fn x() {}\n".repeat(5000),
		});
		expect(out).toContain("Look at the sample and decide how to read it");
		expect(out).toContain("read prose as text, and use code (execute_code) only for data");
	});

	it("says plainly that code is not available, and never shows the whole text", () => {
		for (const over of [{ codeToolOffered: false }, { mountName: undefined }]) {
			const out = block(over);
			expect(out).toContain("too large for this model, and code is not available here");
			expect(out).toContain("switch to a model with a larger context window");
			expect(out).not.toContain("/mnt/data");
			expect(out).not.toContain(big);
		}
	});
});

describe("in the prompt, including earlier turns", () => {
	const file = (name: string, text: string, mime = "text/plain") => ({
		type: "base64" as const,
		name,
		mime,
		value: Buffer.from(text).toString("base64"),
		mountName: name,
		largeAsFile: true,
	});
	const small = {
		type: "base64" as const,
		name: "small.txt",
		mime: "text/plain",
		value: Buffer.from("tiny").toString("base64"),
	};
	const messages = (): EndpointMessage[] => [
		{ from: "user", content: "first question", files: [file("a.json", big, "application/json")] },
		{ from: "assistant", content: "answer" },
		{ from: "user", content: "second question", files: [small] },
	];

	it("replays a pointed-at content as a pointer, and a small one whole", async () => {
		const out = await prepareMessagesWithFiles(messages(), imageProcessor, false, {
			codeToolOffered: true,
		});
		const first = String(out[0].content);
		expect(first).toContain("/mnt/data/a.json");
		expect(first).not.toContain(big);
		expect(first.endsWith("first question")).toBe(true);
		expect(String(out[2].content)).toContain("tiny");
	});

	it("gives the no-code note when code is not offered", async () => {
		const out = await prepareMessagesWithFiles(messages(), imageProcessor, false);
		expect(String(out[0].content)).toContain("code is not available here");
		expect(String(out[0].content)).not.toContain("/mnt/data");
	});
});
