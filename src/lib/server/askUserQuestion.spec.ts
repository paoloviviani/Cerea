import { describe, it, expect } from "vitest";
import {
	normalizeAskUserQuestion,
	answerToToolResult,
	askUserQuestionTool,
	isCatchAllLabel,
} from "./askUserQuestion";

const question = (over: Record<string, unknown> = {}) => ({
	question: "Which database?",
	header: "Database",
	multiSelect: false,
	options: [
		{ label: "Postgres", description: "Relational." },
		{ label: "Mongo", description: "Document." },
	],
	...over,
});

const ok = (args: unknown) => {
	const result = normalizeAskUserQuestion(args);
	if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
	return result.payload;
};

describe("a question from the model", () => {
	it("becomes a select field the existing form can render", () => {
		const payload = ok({ questions: [question()] });
		expect(payload.source).toBe("assistant");
		expect(payload.fields).toEqual([
			{
				kind: "select",
				name: "q1",
				title: "Database",
				description: "Which database?",
				required: true,
				multiple: false,
				allowOther: true,
				options: [
					{ value: "Postgres", label: "Postgres", description: "Relational." },
					{ value: "Mongo", label: "Mongo", description: "Document." },
				],
			},
		]);
	});

	it("carries multiSelect through as a multi-pick that needs an answer", () => {
		const [field] = ok({ questions: [question({ multiSelect: true })] }).fields ?? [];
		expect(field).toMatchObject({ multiple: true, minItems: 1 });
	});

	it("drops options that repeat, since the form keys them by value", () => {
		const [field] =
			ok({
				questions: [
					question({
						options: [
							{ label: "Postgres", description: "One." },
							{ label: "Postgres", description: "Two." },
							{ label: "Mongo", description: "Three." },
						],
					}),
				],
			}).fields ?? [];
		expect(field).toMatchObject({
			options: [
				{ value: "Postgres", label: "Postgres" },
				{ value: "Mongo", label: "Mongo" },
			],
		});
	});

	it("strips control characters out of model-authored text", () => {
		const [field] =
			ok({
				questions: [question({ header: "Data\u0000base\u202E" })],
			}).fields ?? [];
		expect(field).toMatchObject({ title: "Database" });
	});
});

describe("a question that cannot be put to anyone", () => {
	const rejects = (args: unknown) =>
		expect(normalizeAskUserQuestion(args)).toMatchObject({ ok: false });

	it("is refused rather than rendered half-formed", () => {
		rejects({ questions: [] });
		rejects({ questions: [question({ options: [{ label: "Only one", description: "x" }] })] });
		rejects({ questions: [question({ question: "   " })] });
		rejects({ questions: Array.from({ length: 5 }, () => question()) });
	});
});

describe("the result handed back to the model", () => {
	const payload = { ...ok({ questions: [question()] }), elicitationId: "x" };

	it("names the question alongside the choice", () => {
		const text = answerToToolResult(payload, "accept", { q1: "Postgres" });
		expect(text).toContain("Which database?");
		expect(text).toContain("Postgres");
	});

	it("returns every choice of a multi-pick answer", () => {
		expect(answerToToolResult(payload, "accept", { q1: ["Postgres", "Mongo"] })).toContain(
			'A: chose "Postgres", "Mongo"'
		);
	});

	it("marks a chosen option as chosen, and typed text as custom", () => {
		const chosen = answerToToolResult(payload, "accept", { q1: "Postgres" });
		expect(chosen).toContain('Q: Which database?\nA: chose "Postgres"');
		expect(chosen).not.toContain("custom");

		const typed = answerToToolResult(payload, "accept", { q1: "SQLite, it's a toy" });
		expect(typed).toContain(
			'A: typed their own answer (custom, not one of your options) "SQLite, it\'s a toy"'
		);
		expect(typed).not.toContain("chose");
	});

	it("keeps both halves of a multi-pick that mixes options and typed text", () => {
		const multi = { ...ok({ questions: [question({ multiSelect: true })] }), elicitationId: "x" };
		expect(answerToToolResult(multi, "accept", { q1: ["Mongo", "Redis"] })).toContain(
			'A: chose "Mongo"; typed their own answer (custom, not one of your options) "Redis"'
		);
	});

	it("tells the model to carry on when nobody answered", () => {
		expect(answerToToolResult(payload, "decline")).toMatch(/best judgement/);
		expect(answerToToolResult(payload, "cancel")).toMatch(/best judgement/);
	});
});

describe("the tool the model sees", () => {
	const describeAll = (tool: typeof askUserQuestionTool) => JSON.stringify(tool);

	it("tells the model the user can always type their own answer, so it never adds Other", () => {
		for (const tool of [askUserQuestionTool]) {
			expect(tool.function.description).toContain(
				'The user can ALWAYS choose "Other" and type their own answer'
			);
			expect(tool.function.description).toMatch(/never add an "Other"/);
			expect(tool.function.description).toMatch(/1-4 questions/);
			expect(tool.function.description).toMatch(/multiSelect/);
			expect(describeAll(tool)).toMatch(/at most 12 characters/);
			expect(tool.function.description).toMatch(/Never use it to confirm, verify/);
			expect(tool.function.description).toMatch(
				/Never call it in the same step as delivering content/
			);
		}
	});

	it("has no budget field", () => {
		expect(describeAll(askUserQuestionTool)).not.toMatch(/budget/i);
	});
});

describe("a model that adds its own Other anyway", () => {
	it("recognises catch-all labels and nothing that merely starts like one", () => {
		for (const label of [
			"Other",
			"Other (please specify)",
			"Something else",
			"Type my own answer",
			"None of the above",
			"other…",
		]) {
			expect(isCatchAllLabel(label), label).toBe(true);
		}
		for (const label of [
			"Other people's code",
			"Postgres",
			"Customize later",
			"Something elsewhere",
		]) {
			expect(isCatchAllLabel(label), label).toBe(false);
		}
	});

	it("loses the duplicate, keeping the form's own Other", () => {
		const payload = ok({
			questions: [
				question({
					options: [{ label: "Postgres" }, { label: "Mongo" }, { label: "Other (specify)" }],
				}),
			],
		});
		const field = payload.fields?.[0];
		expect(field?.kind === "select" && field.options.map((o) => o.label)).toEqual([
			"Postgres",
			"Mongo",
		]);
		expect(field?.kind === "select" && field.allowOther).toBe(true);
	});

	it("keeps the model's catch-all when dropping it would leave too few options", () => {
		const payload = ok({
			questions: [question({ options: [{ label: "Postgres" }, { label: "Something else" }] })],
		});
		const field = payload.fields?.[0];
		expect(field?.kind === "select" && field.options.map((o) => o.label)).toEqual([
			"Postgres",
			"Something else",
		]);
		expect(field?.kind === "select" && field.allowOther).toBe(false);
	});
});
