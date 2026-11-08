import { describe, expect, it } from "vitest";
import type { TurnRedaction } from "$lib/types/TurnStats";
import {
	dotLabel,
	dotState,
	formatCount,
	formatDuration,
	formatSpeed,
	modeLabel,
	redactionSummary,
	sourceLabel,
	typeName,
} from "./turnDetails";

const redaction = (over: Partial<TurnRedaction> = {}): TurnRedaction => ({
	applied: true,
	blocked: false,
	entities: [],
	...over,
});

describe("dotState", () => {
	it("is neutral with no stats, no redaction, or nothing applied", () => {
		expect(dotState(undefined)).toBe("neutral");
		expect(dotState({})).toBe("neutral");
		expect(dotState({ redaction: redaction({ applied: false }) })).toBe("neutral");
	});
	it("is yellow when values were hidden", () => {
		expect(dotState({ redaction: redaction() })).toBe("applied");
	});
	it("is red when blocked, even if something was also hidden", () => {
		expect(dotState({ redaction: redaction({ blocked: true }) })).toBe("blocked");
	});
	it("names each state in words, so colour is never the only signal", () => {
		const labels = [dotLabel("neutral"), dotLabel("applied"), dotLabel("blocked")];
		expect(new Set(labels).size).toBe(3);
		expect(dotLabel("applied")).toMatch(/hidden/i);
		expect(dotLabel("blocked")).toMatch(/refused/i);
	});
});

describe("redactionSummary", () => {
	it("groups by rule, with counts and friendly names", () => {
		const summary = redactionSummary(
			redaction({
				entities: [
					{
						type: "PERSON",
						count: 2,
						sources: [],
						rule: { name: "Cloud providers", owner: "admin" },
					},
					{
						type: "IT_FISCAL_CODE",
						count: 1,
						sources: [],
						rule: { name: "Cloud providers", owner: "admin" },
					},
					{ type: "record number", count: 1, sources: [], rule: { owner: "user" } },
				],
			})
		);
		expect(summary).toBe(
			"Hidden from the model: 2 names, 1 fiscal code (admin rule “Cloud providers”); 1 record number (your rule)."
		);
	});

	it("says nothing about a rule when there is none", () => {
		expect(
			redactionSummary(redaction({ entities: [{ type: "EMAIL_ADDRESS", count: 1, sources: [] }] }))
		).toBe("Hidden from the model: 1 email address.");
	});
});

describe("words", () => {
	it("names every Presidio type the gateway sends, and leaves custom names alone", () => {
		const types = [
			["PERSON", "name", "names"],
			["LOCATION", "place", "places"],
			["EMAIL_ADDRESS", "email address", "email addresses"],
			["PHONE_NUMBER", "phone number", "phone numbers"],
			["IBAN_CODE", "bank account number", "bank account numbers"],
			["IT_FISCAL_CODE", "fiscal code", "fiscal codes"],
			["IT_IDENTITY_CARD", "identity card number", "identity card numbers"],
			["IT_PASSPORT", "passport number", "passport numbers"],
			["IT_DRIVER_LICENSE", "driving licence number", "driving licence numbers"],
			["CREDIT_CARD", "card number", "card numbers"],
			["DATE_TIME", "date or time", "dates or times"],
		] as const;
		for (const [type, one, many] of types) {
			expect(typeName(type, 1)).toBe(one);
			expect(typeName(type, 2)).toBe(many);
		}
		expect(typeName("MY_PATTERN", 3)).toBe("MY_PATTERN");
	});

	it("says the mode in plain words", () => {
		expect(modeLabel("restore")).toBe("restored in the answer");
		expect(modeLabel("redact")).toBe("kept hidden");
		expect(modeLabel("block")).toBe("request refused");
		expect(modeLabel(undefined)).toBe("");
	});

	it("says where a value came from", () => {
		expect(sourceLabel("user")).toBe("from your message");
		expect(sourceLabel("tool_result")).toBe("from a tool result");
		expect(sourceLabel("system")).toBe("from system");
	});

	it("shows a dash for what is not known", () => {
		expect(formatCount(undefined)).toBe("—");
		expect(formatDuration(undefined)).toBe("—");
		expect(formatSpeed(undefined)).toBe("—");
		expect(formatDuration(340)).toBe("340 ms");
		expect(formatDuration(1250)).toBe("1.3 s");
		expect(formatSpeed(42.5)).toBe("42.5 tokens/s");
	});
});
