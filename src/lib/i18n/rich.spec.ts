import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages";
import { richSegments } from "./rich";

describe("richSegments", () => {
	it("folds markup parts into text and tagged text", () => {
		expect(
			richSegments([
				{ type: "text", value: "Set via " },
				{ type: "markup-start", name: "code" },
				{ type: "text", value: "TASK_MODEL" },
				{ type: "markup-end", name: "code" },
				{ type: "text", value: "." },
			])
		).toEqual([{ text: "Set via " }, { tag: "code", text: "TASK_MODEL" }, { text: "." }]);
	});

	it("reads a real catalogue message", () => {
		const segments = richSegments(
			m["settings.application.task_model.description"].parts({ name: "TASK_MODEL" })
		);
		expect(segments.some((s) => s.tag === "code" && s.text === "TASK_MODEL")).toBe(true);
	});

	it("flattens a nested tag to plain text rather than losing it", () => {
		expect(
			richSegments([
				{ type: "markup-start", name: "a" },
				{ type: "markup-start", name: "b" },
				{ type: "text", value: "x" },
				{ type: "markup-end", name: "b" },
				{ type: "markup-end", name: "a" },
			])
		).toEqual([{ tag: "a", text: "x" }]);
	});
});
