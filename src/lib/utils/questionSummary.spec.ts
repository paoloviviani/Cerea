import { describe, expect, it } from "vitest";
import type { ElicitationField } from "$lib/types/McpElicitation";
import { questionSummary } from "./questionSummary";

const format: ElicitationField = {
	kind: "select",
	name: "q0",
	title: "Format",
	description: "Which format should the summary use?",
	required: true,
	multiple: false,
	options: [
		{ value: "Bullet points", label: "Bullet points" },
		{ value: "One paragraph", label: "One paragraph" },
	],
	allowOther: true,
};

describe("questionSummary", () => {
	const ask = { source: "assistant" as const, message: "Which format?", fields: [format] };

	it("names the question and the chosen option, never the server", () => {
		expect(questionSummary(ask, { q0: "Bullet points" })).toBe("Format → Bullet points");
	});

	it("marks a free-text answer as Other and truncates it", () => {
		const long = "a very specific custom layout with headings and a table ".repeat(3);
		const out = questionSummary(ask, { q0: long }) ?? "";
		expect(out.startsWith("Format → Other: a very specific")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});

	it("joins multi-select choices and several questions", () => {
		const scope: ElicitationField = { ...format, name: "q1", title: "Scope", multiple: true };
		const out = questionSummary(
			{ ...ask, fields: [format, scope] },
			{ q0: "One paragraph", q1: ["Bullet points", "One paragraph"] }
		);
		expect(out).toBe("Format → One paragraph · Bullet points, One paragraph");
	});

	it("falls back to the question text without a header, and to the head alone before an answer", () => {
		const noHeader = { ...format, title: undefined };
		expect(questionSummary({ ...ask, fields: [noHeader] }, undefined)).toBe(
			"Which format should the summary use?"
		);
	});

	it("leaves an MCP server's elicitation alone", () => {
		expect(questionSummary({ message: "Log in?", fields: [] }, { x: "y" })).toBeNull();
	});
});
