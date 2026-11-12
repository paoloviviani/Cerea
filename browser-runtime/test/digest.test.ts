import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { actionDigest } from "../src/classifier.ts";
import type { BrowserAction } from "../src/contract.ts";

// The digest as the contract documents it: the first 32 hex characters of SHA-256 over
// JSON.stringify([kind, ref, value, url, name, decided.reason ?? "", decided.targetHost ?? "", decided.download ? "1" : "0"]). Computed here independently of the classifier.
const expected = (
	kind: string,
	ref: string,
	value: string,
	name: string,
	url: string,
	decided: { reason?: string; targetHost?: string; download?: boolean } = {}
) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				kind,
				ref,
				value,
				url,
				name,
				decided.reason ?? "",
				decided.targetHost ?? "",
				decided.download ? "1" : "0",
			])
		)
		.digest("hex")
		.slice(0, 32);

const el = (name: string) => ({ ref: "e5", role: "button", name });

describe("approval digest (contract vectors)", () => {
	const url = "https://shop.example.com/cart?x=1";
	const cases: Array<[string, BrowserAction, string, string, string, string]> = [
		["click", { type: "click", ref: "e5" }, "click", "e5", "", "Pay €120"],
		["fill", { type: "fill", ref: "e5", text: "hi" }, "fill", "e5", "hi", "Name"],
		[
			"fill submit",
			{ type: "fill", ref: "e5", text: "hi", submit: true },
			"fill",
			"e5",
			"hi\n#submit",
			"Name",
		],
		["select", { type: "select", ref: "e5", value: "B" }, "select", "e5", "B", "Role"],
		["press", { type: "press", key: "Enter", ref: "e5" }, "press", "e5", "enter", "Name"],
		["press no ref", { type: "press", key: "Enter" }, "press", "", "enter", ""],
		["press normalised", { type: "press", key: "NumpadEnter" }, "press", "", "enter", ""],
		[
			"press modified",
			{ type: "press", key: "Control+Enter", ref: "e5" },
			"press",
			"e5",
			"enter+mod",
			"Name",
		],
		[
			"navigate",
			{ type: "navigate", url: "https://other.example/a" },
			"navigate",
			"",
			"https://other.example/a",
			"",
		],
		["scroll", { type: "scroll", direction: "down", amount: 3 }, "scroll", "", "down:3", ""],
		["wait text", { type: "wait_for", text: "Done" }, "wait_for", "", "Done", ""],
		["wait ms", { type: "wait_for", ms: 500 }, "wait_for", "", "500", ""],
	];
	// The facts that decided each action's class, as the classifier reports them.
	const decided: Record<string, { reason?: string; targetHost?: string }> = {
		click: { reason: "verb" },
		"fill submit": { reason: "submit" },
		"press no ref": { reason: "unknown-element" },
		"press normalised": { reason: "unknown-element" },
		"press modified": { reason: "submit" },
		navigate: { reason: "new-domain", targetHost: "other.example" },
	};
	for (const [label, action, kind, ref, value, name] of cases) {
		it(label, () => {
			const element = "ref" in action && action.ref ? el(name) : undefined;
			assert.equal(
				actionDigest(action, { element, currentUrl: url }),
				expected(kind, ref, value, name, "https://shop.example.com/cart?x=1", decided[label])
			);
		});
	}

	it("leaves the fragment out of the url, and keeps the query", () => {
		const a = actionDigest(
			{ type: "click", ref: "e5" },
			{ element: el("Pay"), currentUrl: `${url}#top` }
		);
		assert.equal(
			a,
			actionDigest({ type: "click", ref: "e5" }, { element: el("Pay"), currentUrl: url })
		);
		assert.notEqual(
			a,
			actionDigest(
				{ type: "click", ref: "e5" },
				{ element: el("Pay"), currentUrl: "https://shop.example.com/cart?x=2" }
			)
		);
	});

	it("differs for another page, name or text", () => {
		const a = actionDigest({ type: "click", ref: "e5" }, { element: el("Pay"), currentUrl: url });
		assert.notEqual(
			a,
			actionDigest(
				{ type: "click", ref: "e5" },
				{ element: el("Pay"), currentUrl: "https://evil.example/" }
			)
		);
		assert.notEqual(
			a,
			actionDigest({ type: "click", ref: "e5" }, { element: el("Payy"), currentUrl: url })
		);
	});
});

// The literal vectors in Cerea's classifier.spec.ts ("the runtime must reproduce these").
describe("approval digest (Cerea's literal vectors)", () => {
	const at = "https://shop.example.com/checkout";
	const el = (over: { name: string; role?: string }) => ({ ref: "e1", role: "button", ...over });
	it("matches them", () => {
		assert.equal(
			actionDigest(
				{ type: "click", ref: "e3" },
				{ element: { ...el({ name: "Pay €120" }), ref: "e3" }, currentUrl: at }
			),
			"3127a4f00b0eb649d1dbc6c853147aa6"
		);
		assert.equal(
			actionDigest(
				{ type: "fill", ref: "e1", text: "hello", submit: true },
				{ element: el({ role: "textbox", name: "Search" }), currentUrl: at }
			),
			"0ecbe3c8aa998d7f50d6f12fdc49ba51"
		);
		assert.equal(
			actionDigest({ type: "navigate", url: "https://other.example.org/x" }, { currentUrl: at }),
			"a6c7a2fae7c2c894dd073001020ab7da"
		);
	});
});

// Cerea's loop.tabs.spec.ts: a use_tab grant binds the tab id, its address without fragment and
// its title, computed here independently of the classifier.
describe("use_tab digest", () => {
	it("matches the documented canonical form", () => {
		const tab = { id: "t9", url: "https://flights.example.com/s?q=1#frag", title: "Flights" };
		const want = createHash("sha256")
			.update(
				JSON.stringify([
					"use_tab",
					"t9",
					"",
					"https://flights.example.com/s?q=1",
					"Flights",
					"user-tab",
					"",
					"0",
				])
			)
			.digest("hex")
			.slice(0, 32);
		assert.equal(
			actionDigest(
				{ type: "use_tab", tab: "t9" },
				{ currentUrl: "https://shop.example.com/", tab }
			),
			want
		);
	});
});
