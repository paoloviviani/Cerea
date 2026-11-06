import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config", () => ({ config: { getSaved: () => undefined } }));

import { pickTitleModel } from "./titleModel";

const catalogue = [
	{ id: "thinker", name: "thinker", supportsReasoning: true },
	{ id: "plain", name: "plain", supportsReasoning: false },
];

describe("pickTitleModel", () => {
	it("uses the administrator's choice when the catalogue lists it", () => {
		expect(pickTitleModel({ stored: "thinker", env: "x", convModel: "plain", catalogue })).toBe(
			"thinker"
		);
	});
	it("ignores a stored model the catalogue no longer lists", () => {
		expect(pickTitleModel({ stored: "gone", env: undefined, convModel: "plain", catalogue })).toBe(
			"plain"
		);
	});
	it("uses TASK_MODEL when nothing is chosen", () => {
		expect(pickTitleModel({ stored: null, env: "task", convModel: "thinker", catalogue })).toBe(
			"task"
		);
	});
	it("automatic keeps the conversation's own model when it does not reason", () => {
		expect(pickTitleModel({ stored: null, env: "", convModel: "plain", catalogue })).toBe("plain");
	});
	it("automatic prefers a listed non-reasoning model over a reasoning conversation model", () => {
		expect(pickTitleModel({ stored: null, env: "", convModel: "thinker", catalogue })).toBe(
			"plain"
		);
	});
	it("automatic falls back to the conversation's model when every model reasons", () => {
		expect(
			pickTitleModel({
				stored: null,
				env: "",
				convModel: "thinker",
				catalogue: catalogue.slice(0, 1),
			})
		).toBe("thinker");
	});
	it("automatic prefers a hidden non-reasoning model set aside for tasks", () => {
		const withHidden = [
			...catalogue,
			{ id: "aside", name: "aside", supportsReasoning: false, unlisted: true },
		];
		expect(
			pickTitleModel({ stored: null, env: "", convModel: "plain", catalogue: withHidden })
		).toBe("aside");
		expect(
			pickTitleModel({ stored: null, env: "", convModel: "thinker", catalogue: withHidden })
		).toBe("aside");
	});
	it("automatic ignores a hidden model that reasons", () => {
		const withHidden = [
			{ id: "dim", name: "dim", supportsReasoning: true, unlisted: true },
			...catalogue,
		];
		expect(
			pickTitleModel({ stored: null, env: "", convModel: "plain", catalogue: withHidden })
		).toBe("plain");
	});
	it("a stored choice may be a hidden model", () => {
		const withHidden = [{ id: "aside", name: "aside", unlisted: true }, ...catalogue];
		expect(
			pickTitleModel({ stored: "aside", env: "", convModel: "plain", catalogue: withHidden })
		).toBe("aside");
	});
});
