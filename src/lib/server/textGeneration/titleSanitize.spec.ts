import { describe, expect, it } from "vitest";
import { sanitiseTitle } from "./titleSanitize";

describe("sanitiseTitle", () => {
	it("strips control tokens", () => {
		expect(
			sanitiseTitle("<|start|>assistant<|channel|>Note app comparison", "compare note apps")
		).toBe("Note app comparison");
	});
	it("refuses a token-only title", () => {
		expect(sanitiseTitle("<|start|>assistant<|channel|>", "hi")).toBeUndefined();
	});
	it("refuses refusals and meta", () => {
		expect(
			sanitiseTitle("I'm unable to execute code or generate images", "draw a cat")
		).toBeUndefined();
		expect(sanitiseTitle("Sorry, I can't help", "x")).toBeUndefined();
	});
	it("removes quotes and labels, caps at six words", () => {
		expect(sanitiseTitle('"Title: one two three four five six seven eight"')).toBe(
			"one two three four five six"
		);
	});
	it("rejects another language than the user's", () => {
		const user = "Can you compare the best note-taking apps for me?";
		expect(sanitiseTitle("Confronto delle app per note", user)).toBe(
			"Confronto delle app per note"
		);
		expect(sanitiseTitle("Che cosa sono le app per il confronto", user)).toBeUndefined();
		expect(sanitiseTitle("Transformer 工作原理", user)).toBeUndefined();
		expect(sanitiseTitle("Transformer 工作原理", "请解释Transformer是如何工作的")).toBe(
			"Transformer 工作原理"
		);
	});
});
