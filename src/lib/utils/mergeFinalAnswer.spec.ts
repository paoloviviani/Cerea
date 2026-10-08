import { describe, expect, test } from "vitest";
import { finalAnswerAddition, mergeFinalAnswerContent } from "./mergeFinalAnswer";

const merge = mergeFinalAnswerContent;

describe("mergeFinalAnswerContent — no tools", () => {
	test("the provider's final text is authoritative, replacing streamed content", () => {
		expect(
			merge({ existing: "partial", finalText: "final", hadTools: false, isInterrupted: false })
		).toBe("final");
	});

	test("an empty final text clears the content", () => {
		expect(
			merge({ existing: "partial", finalText: "", hadTools: false, isInterrupted: false })
		).toBe("");
	});

	test("adopts the final text even when nothing was streamed", () => {
		expect(merge({ existing: "", finalText: "final", hadTools: false, isInterrupted: false })).toBe(
			"final"
		);
	});
});

describe("mergeFinalAnswerContent — interrupted", () => {
	test("nothing streamed falls back to the final text", () => {
		expect(
			merge({ existing: "", finalText: "clamped", hadTools: false, isInterrupted: true })
		).toBe("clamped");
	});

	test("adopts the final text when it is a prefix of what we streamed (server clamp)", () => {
		// The server clamped the persisted text back to the stop point; adopt it so
		// this view matches every other view.
		expect(
			merge({
				existing: "hello world extra",
				finalText: "hello world",
				hadTools: false,
				isInterrupted: true,
			})
		).toBe("hello world");
	});

	test("keeps our streamed content when the final text is not a prefix", () => {
		// A continue flow may return only post-prefix text; do not clobber what we have.
		expect(
			merge({
				existing: "hello world",
				finalText: "different",
				hadTools: false,
				isInterrupted: true,
			})
		).toBe("hello world");
	});

	test("an empty final text leaves streamed content untouched", () => {
		expect(
			merge({ existing: "streamed so far", finalText: "", hadTools: false, isInterrupted: true })
		).toBe("streamed so far");
	});

	test("interrupted takes precedence over tools", () => {
		expect(merge({ existing: "abc", finalText: "abc", hadTools: true, isInterrupted: true })).toBe(
			"abc"
		);
	});
});

describe("mergeFinalAnswerContent — tools (case A: already streamed)", () => {
	test("a step break after </think> inside the final text still counts as streamed", () => {
		const existing = "<think>plan</think>Checking.\n\n<think>done</think>\n\nAnswer.";
		expect(
			merge({
				existing,
				finalText: "<think>done</think>Answer.",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe(existing);
	});

	test("keeps existing when it ends with the final text verbatim", () => {
		expect(
			merge({
				existing: "story then answer",
				finalText: "answer",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("story then answer");
	});

	test("keeps existing when it ends with the final text modulo surrounding whitespace", () => {
		expect(
			merge({
				existing: "story\nanswer  ",
				finalText: "  answer",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("story\nanswer  ");
	});

	test("keeps existing when the final differs only by line endings", () => {
		expect(
			merge({
				existing: "Ciao!\n\nFatto, eccola.",
				finalText: "Fatto, eccola.\r\n",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("Ciao!\n\nFatto, eccola.");
	});

	test("keeps existing when the final differs only by Unicode normalization", () => {
		expect(
			merge({
				existing: `Intro\n\n${"più di una?".normalize("NFD")}`,
				finalText: "più di una?",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe(`Intro\n\n${"più di una?".normalize("NFD")}`);
	});
});

describe("mergeFinalAnswerContent — tools (case B: final includes streamed prefix)", () => {
	test("uses the final text verbatim when it starts with what we streamed", () => {
		expect(
			merge({
				existing: "The story",
				finalText: "The story and its caption",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("The story and its caption");
	});

	test("uses the final text when it starts with the streamed prefix modulo whitespace", () => {
		expect(
			merge({
				existing: "The story  ",
				finalText: "The story continues",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("The story continues");
	});
});

describe("mergeFinalAnswerContent — tools (case C: distinct, join with a gap)", () => {
	test("joins distinct pre-tool and post-tool text with a paragraph break", () => {
		expect(
			merge({
				existing: "A story.",
				finalText: "An image caption.",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("A story.\n\nAn image caption.");
	});

	test("does not add a gap when existing already ends with a blank line", () => {
		expect(
			merge({
				existing: "A story.\n\n",
				finalText: "Caption.",
				hadTools: true,
				isInterrupted: false,
			})
		).toBe("A story.\n\nCaption.");
	});

	test("does not add a gap when the final text already starts with a newline", () => {
		expect(
			merge({ existing: "A story.", finalText: "\nCaption.", hadTools: true, isInterrupted: false })
		).toBe("A story.\nCaption.");
	});

	test("falls back to the final text when nothing was streamed before the tools", () => {
		expect(
			merge({ existing: "", finalText: "Only the caption.", hadTools: true, isInterrupted: false })
		).toBe("Only the caption.");
	});
});

describe("finalAnswerAddition — what a message view appends after its streamed blocks", () => {
	test("nothing when the final answer is the streamed tail with the step break inside it", () => {
		// The view's text blocks hold the narration plus the last step, with the
		// paragraph break the server inserts after a tool right after </think>;
		// the provider's final text has no such break.
		const streamed =
			"Perfetto, verifico le fonti.Ho completato la ricerca.</think>\n\n## In sintesi\n\n- Sì.";
		const finalText = "Ho completato la ricerca.</think>## In sintesi\n\n- Sì.";
		expect(finalAnswerAddition(streamed, finalText)).toBe("");
	});

	test("nothing when only line endings or Unicode normalization differ", () => {
		expect(finalAnswerAddition("Perché sì.\n", "Perché sì.\r\n")).toBe("");
	});

	test("only the unstreamed tail when the final text extends the stream", () => {
		expect(finalAnswerAddition("Intro.", "Intro. More.")).toBe(" More.");
		// The same, with a whitespace difference at the seam inside the prefix.
		expect(finalAnswerAddition("Intro.\n\nStep two", "Intro.Step two, done.")).toBe(", done.");
	});

	test("the whole final text after a paragraph break when it is new", () => {
		expect(finalAnswerAddition("Before the tool.", "After the tool.")).toBe("\n\nAfter the tool.");
		expect(finalAnswerAddition("", "Only final.")).toBe("Only final.");
		expect(finalAnswerAddition("Streamed.", "")).toBe("");
	});

	test("agrees with the stored content for every case", () => {
		const cases: Array<[string, string]> = [
			["Narration.Answer.</think>\n\nBody", "Answer.</think>Body"],
			["Intro.", "Intro. More."],
			["Before the tool.", "After the tool."],
		];
		for (const [streamed, finalText] of cases) {
			const stored = mergeFinalAnswerContent({
				existing: streamed,
				finalText,
				hadTools: true,
				isInterrupted: false,
			});
			const rendered = streamed + finalAnswerAddition(streamed, finalText);
			expect(rendered.replace(/\s+/g, "")).toBe(stored.replace(/\s+/g, ""));
		}
	});
});
