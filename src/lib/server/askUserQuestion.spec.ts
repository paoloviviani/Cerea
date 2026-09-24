import { describe, it, expect } from "vitest";
import {
	normalizeAskUserQuestion,
	answerToToolResult,
	chosenBudgetUsd,
	askUserQuestionTool,
	askUserQuestionToolPlain,
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

describe("options that grant budget", () => {
	const budgetQuestion = (setBudgetUsd: unknown) =>
		question({
			options: [
				{ label: "Rescope to a subset", description: "Half the data, half the cost." },
				{ label: "Run it in full", description: "The whole dataset.", setBudgetUsd },
			],
		});

	it("keeps a sane amount on the option and generates its title from it", () => {
		const payload = ok({ questions: [budgetQuestion(4.5)] });
		const field = payload.fields?.[0];
		if (field?.kind !== "select") throw new Error("expected a select");
		expect(field.options[1].setBudgetUsd).toBe(4.5);
		// The model's label is ignored outright — the title is the amount, so no
		// authored text can contradict what a click applies.
		expect(field.options[1].label).toBe("Set budget to $4.50");
		expect(field.options[1].description).toBe("The whole dataset.");
		expect(field.options[0].setBudgetUsd).toBeUndefined();
		expect(field.options[0].label).toBe("Rescope to a subset");
	});

	it("drops the model's label entirely, even as a description fallback", () => {
		const payload = ok({
			questions: [
				question({
					options: [
						{ label: "Rescope", description: "Half the data." },
						{ label: "Set the budget to $1", setBudgetUsd: 1000 },
					],
				}),
			],
		});
		const field = payload.fields?.[0];
		if (field?.kind !== "select") throw new Error("expected a select");
		expect(field.options[1].label).toBe("Set budget to $1000.00");
		expect(field.options[1].description).toBeUndefined();
	});

	it("collapses two grants of the same amount into one option", () => {
		const payload = ok({
			questions: [
				question({
					options: [
						{ label: "Cheap", description: "A.", setBudgetUsd: 5 },
						{ label: "Also cheap", description: "B.", setBudgetUsd: 5 },
						{ label: "Rescope", description: "C." },
					],
				}),
			],
		});
		const field = payload.fields?.[0];
		if (field?.kind !== "select") throw new Error("expected a select");
		expect(field.options.map((o) => o.label)).toEqual(["Set budget to $5.00", "Rescope"]);
	});

	it("drops garbage amounts and clamps absurd ones", () => {
		for (const bad of [-3, 0, NaN, Infinity, "10"]) {
			const payload = ok({ questions: [budgetQuestion(bad)] });
			const field = payload.fields?.[0];
			if (field?.kind !== "select") throw new Error("expected a select");
			expect(field.options[1].setBudgetUsd).toBeUndefined();
		}
		const payload = ok({ questions: [budgetQuestion(1_000_000)] });
		const field = payload.fields?.[0];
		if (field?.kind !== "select") throw new Error("expected a select");
		expect(field.options[1].setBudgetUsd).toBe(10_000);
	});

	it("reads the grant from the chosen option, never from typed text", () => {
		const payload = { ...ok({ questions: [budgetQuestion(4.5)] }), elicitationId: "x" };
		expect(chosenBudgetUsd(payload, { q1: "Set budget to $4.50" })).toBe(4.5);
		expect(chosenBudgetUsd(payload, { q1: "Rescope to a subset" })).toBeUndefined();
		// "Other" text that mimics the grant wording grants nothing.
		expect(chosenBudgetUsd(payload, { q1: "set budget to $4.50 please" })).toBeUndefined();
	});

	it("tells the model the budget it now has", () => {
		const payload = { ...ok({ questions: [budgetQuestion(4.5)] }), elicitationId: "x" };
		expect(answerToToolResult(payload, "accept", { q1: "Set budget to $4.50" })).toContain(
			"The session compute budget is now $4.50."
		);
		expect(answerToToolResult(payload, "accept", { q1: "Rescope to a subset" })).not.toContain(
			"budget is now"
		);
	});
});

describe("budget questions must carry real grants", () => {
	// The observed failure: dollar amounts in labels, no setBudgetUsd anywhere —
	// the user clicks "$1", nothing reaches the ledger.
	it("bounces a budget question whose options only wave dollar amounts", () => {
		const result = normalizeAskUserQuestion({
			questions: [
				question({
					question: "What compute budget should I reserve against?",
					options: [
						{ label: "$1 — enough for a tiny check", description: "Minimal." },
						{ label: "$5", description: "Room for retries." },
					],
				}),
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("setBudgetUsd");
	});

	it("passes once at least one option carries the grant", () => {
		const payload = ok({
			questions: [
				question({
					question: "What compute budget should I reserve against?",
					options: [
						{ label: "$1 — tiny check", description: "Minimal.", setBudgetUsd: 1 },
						{ label: "$0 — no raise", description: "Keep as is." },
					],
				}),
			],
		});
		const field = payload.fields?.[0];
		if (field?.kind !== "select") throw new Error("expected a select");
		expect(field.options[0].setBudgetUsd).toBe(1);
	});

	it("leaves non-budget questions alone however much they talk prices", () => {
		const payload = ok({
			questions: [
				question({
					question: "Which flavor should the run use?",
					options: [
						{ label: "t4-small ($0.40/hr)", description: "Cheapest GPU." },
						{ label: "a10g-large ($1.50/hr)", description: "Faster." },
					],
				}),
			],
		});
		expect(payload.fields).toHaveLength(1);
	});
});

describe("the tool the model sees", () => {
	const describeAll = (tool: typeof askUserQuestionTool) => JSON.stringify(tool);

	it("tells the model the user can always type their own answer, so it never adds Other", () => {
		for (const tool of [askUserQuestionTool, askUserQuestionToolPlain]) {
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

	it("offers setBudgetUsd only in the variant that can grant budget", () => {
		expect(describeAll(askUserQuestionTool)).toContain("setBudgetUsd");
		expect(describeAll(askUserQuestionToolPlain)).not.toContain("setBudgetUsd");
		expect(describeAll(askUserQuestionToolPlain)).not.toMatch(/budget/i);
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
