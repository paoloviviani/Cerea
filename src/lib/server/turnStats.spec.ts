import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRedaction } from "$lib/types/TurnStats";
import {
	TurnStatsCollector,
	aggregateRedaction,
	parseCost,
	parseRedaction,
	readCallReport,
	redactionRequestHeaders,
	stripRedactionValues,
	sumCosts,
} from "./turnStats";

const FULL = {
	applied: true,
	request_id: "req_1",
	blocked: false,
	entities: [
		{
			type: "PERSON",
			count: 2,
			mode: "restore",
			rule: { id: "r1", name: "Cloud providers", owner: "admin" },
			sources: ["user", "tool"],
		},
	],
	values: [{ type: "PERSON", original: "Mario Rossi", placeholder: "<PERSON_1>" }],
};

describe("parseRedaction", () => {
	it("reads the object as it sits in a JSON body", () => {
		const parsed = readCallReport({
			choices: [],
			usage: { prompt_tokens: 12, completion_tokens: 3 },
			pystino_cost: "0.0042 USD",
			pystino_redaction: FULL,
		});
		expect(parsed.inputTokens).toBe(12);
		expect(parsed.outputTokens).toBe(3);
		expect(parsed.cost).toBe("0.0042 USD");
		// The request id is the gateway's own and is not kept with the message.
		expect(parsed.redaction).toEqual({ ...FULL, request_id: undefined });
	});

	it("reads the object off a streaming usage chunk (no choices)", () => {
		const chunk = {
			id: "c",
			choices: [],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 9,
				completion_tokens_details: { reasoning_tokens: 4 },
			},
			pystino_redaction: { ...FULL, values: undefined },
		};
		const report = readCallReport(chunk);
		expect(report.reasoningTokens).toBe(4);
		expect(report.redaction?.entities[0].count).toBe(2);
		expect(report.redaction?.values).toBeUndefined();
	});

	it("tolerates every field arriving as null", () => {
		const parsed = parseRedaction({
			applied: null,
			request_id: null,
			blocked: null,
			entities: [
				{ type: "IBAN_CODE", count: null, mode: null, rule: null, sources: null },
				{ type: null },
			],
			values: null,
		});
		expect(parsed).toEqual({
			applied: false,
			blocked: false,
			entities: [{ type: "IBAN_CODE", count: 1, sources: [] }],
		});
	});

	it("is undefined when the object is absent or not an object", () => {
		expect(parseRedaction(undefined)).toBeUndefined();
		expect(parseRedaction(null)).toBeUndefined();
		expect(parseRedaction("x")).toBeUndefined();
		expect(readCallReport({ pystino_cost: null }).cost).toBeUndefined();
	});

	it("only takes a string as a cost", () => {
		expect(parseCost(" 1.5 EUR ")).toBe("1.5 EUR");
		expect(parseCost(3)).toBeUndefined();
		expect(parseCost("")).toBeUndefined();
	});
});

describe("aggregateRedaction", () => {
	it("sums counts per rule, unions sources, blocks if any call blocked, and keeps values", () => {
		const a = parseRedaction(FULL) as TurnRedaction;
		const b = parseRedaction({
			...FULL,
			blocked: true,
			entities: [
				{ ...FULL.entities[0], count: 1, sources: ["user"] },
				{ type: "IT_FISCAL_CODE", count: 1, mode: "hide", rule: { owner: "user" }, sources: [] },
			],
			values: [{ type: "IT_FISCAL_CODE", original: "RSSMRA80A01H501U" }],
		}) as TurnRedaction;
		const total = aggregateRedaction([a, b]) as TurnRedaction;
		expect(total.blocked).toBe(true);
		expect(total.applied).toBe(true);
		expect(total.entities).toHaveLength(2);
		expect(total.entities[0]).toMatchObject({
			type: "PERSON",
			count: 3,
			sources: ["user", "tool"],
		});
		expect(total.values).toHaveLength(2);
	});

	it("is undefined for no calls", () => {
		expect(aggregateRedaction([])).toBeUndefined();
	});
});

describe("sumCosts", () => {
	it("adds costs that share a unit, and gives up on mixed ones", () => {
		expect(sumCosts(["0.0042 USD", "0.0010 USD"])).toBe("0.0052 USD");
		expect(sumCosts(["0.1 USD", "0.1 EUR"])).toBeUndefined();
		expect(sumCosts(["odd"])).toBe("odd");
		expect(sumCosts([])).toBeUndefined();
	});
});

describe("redactionRequestHeaders", () => {
	it("always asks for the summary, and for the values only while the setting is on", () => {
		expect(redactionRequestHeaders(undefined)).toEqual({ "x-pystino-redaction-summary": "1" });
		expect(redactionRequestHeaders({ showRedactionValues: false })).toEqual({
			"x-pystino-redaction-summary": "1",
		});
		expect(redactionRequestHeaders({ showRedactionValues: true })).toEqual({
			"x-pystino-redaction-summary": "1",
			"x-pystino-redaction-values": "1",
		});
	});
});

describe("TurnStatsCollector timing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
	});
	afterEach(() => vi.useRealTimers());

	it("measures the first token and the speed from the first token to the end", () => {
		const stats = new TurnStatsCollector({ model: "Test model" });
		const call = stats.begin();
		vi.advanceTimersByTime(400);
		call.token();
		vi.advanceTimersByTime(1000);
		call.token();
		vi.advanceTimersByTime(1000);
		call.token();
		call.report = { outputTokens: 40 };
		const snap = stats.snapshot();
		expect(snap.model).toBe("Test model");
		expect(snap.firstTokenMs).toBe(400);
		expect(snap.tokensPerSecond).toBe(20);
		expect(snap.at).toBe(new Date("2026-11-08T10:00:00Z").getTime());
	});

	it("leaves the pauses between calls out of the speed", () => {
		const stats = new TurnStatsCollector();
		const first = stats.begin();
		vi.advanceTimersByTime(100);
		first.token();
		vi.advanceTimersByTime(1000);
		first.token();
		first.report = { outputTokens: 10 };
		vi.advanceTimersByTime(60_000); // a slow tool
		const second = stats.begin();
		vi.advanceTimersByTime(900);
		second.token();
		vi.advanceTimersByTime(1000);
		second.token();
		second.report = { outputTokens: 30 };
		const snap = stats.snapshot();
		expect(snap.firstTokenMs).toBe(100);
		expect(snap.tokensPerSecond).toBe(20);
		expect(snap.outputTokens).toBe(40);
	});

	it("shows gaps, not numbers, when nothing arrived", () => {
		const stats = new TurnStatsCollector();
		stats.begin();
		const snap = stats.snapshot();
		expect(snap.firstTokenMs).toBeUndefined();
		expect(snap.tokensPerSecond).toBeUndefined();
		expect(snap.inputTokens).toBeUndefined();
		expect(snap.redaction).toBeUndefined();
	});

	it("gives no speed for an answer that came in one piece", () => {
		const stats = new TurnStatsCollector();
		const call = stats.begin();
		vi.advanceTimersByTime(800);
		call.token();
		call.report = { outputTokens: 12 };
		expect(stats.snapshot().tokensPerSecond).toBeUndefined();
	});
});

describe("stripRedactionValues", () => {
	it("removes the values and nothing else, without touching the input", () => {
		const messages = [
			{ id: "a", stats: { model: "m", redaction: parseRedaction(FULL) as TurnRedaction } },
			{ id: "b" },
		];
		const out = stripRedactionValues(messages);
		expect(out[0].stats?.redaction).not.toHaveProperty("values");
		expect(out[0].stats?.redaction?.entities).toHaveLength(1);
		expect(out[0].stats?.model).toBe("m");
		expect(out[1]).toBe(messages[1]);
		expect(messages[0].stats?.redaction?.values).toHaveLength(1);
		expect(JSON.stringify(out)).not.toContain("Mario Rossi");
	});
});
