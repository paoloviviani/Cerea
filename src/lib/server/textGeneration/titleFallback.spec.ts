import { describe, expect, it } from "vitest";
import { fallbackTitle } from "./titleFallback";

describe("fallbackTitle", () => {
	it("keeps a short whole sentence", () => {
		expect(fallbackTitle("Cosa puoi fare per me?")).toBe("Cosa puoi fare per me?");
		expect(fallbackTitle("What is the capital of France?")).toBe("What is the capital of France?");
	});

	it("takes the first sentence only", () => {
		expect(fallbackTitle("Fix my login. It fails with a 500 error on submit")).toBe("Fix my login");
	});

	it("cuts at six words with an ellipsis", () => {
		expect(fallbackTitle("I want to build a semi-technical slide deck about our roadmap")).toBe(
			"I want to build a semi-technical…"
		);
	});

	it("drops trailing function words (English)", () => {
		expect(fallbackTitle("Can you help me write a letter to the bank")).toBe(
			"Can you help me write…"
		);
		expect(fallbackTitle("I want to build a deck for our team of engineers")).toBe(
			"I want to build a deck…"
		);
	});

	it("drops trailing function words (Italian)", () => {
		expect(fallbackTitle("Vorrei sapere come aprire un conto con la banca")).toBe(
			"Vorrei sapere come aprire un conto…"
		);
		expect(fallbackTitle("Vorrei sapere cosa posso fare per la mia famiglia")).toBe(
			"Vorrei sapere cosa posso fare…"
		);
		expect(fallbackTitle("Mi puoi spiegare la differenza tra il leasing e il noleggio")).toBe(
			"Mi puoi spiegare la differenza…"
		);
	});

	it("cuts text without spaces", () => {
		const out = fallbackTitle("请".repeat(200));
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThan(60);
	});

	it("never strips down to nothing", () => {
		expect(fallbackTitle("Per per per per per per per")).toBe("Per…");
	});
});
