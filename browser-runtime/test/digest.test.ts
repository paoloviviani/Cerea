import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { actionDigest } from "../src/classifier.ts";
import type { BrowserAction } from "../src/contract.ts";

// The digest as the contract documents it: the first 32 hex characters of SHA-256 over
// JSON.stringify([kind, ref, value, url, name]). Computed here independently of the classifier.
const expected = (kind: string, ref: string, value: string, name: string, url: string) =>
	createHash("sha256")
		.update(JSON.stringify([kind, ref, value, url, name]))
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
	for (const [label, action, kind, ref, value, name] of cases) {
		it(label, () => {
			const element = "ref" in action && action.ref ? el(name) : undefined;
			assert.equal(
				actionDigest(action, { element, currentUrl: url }),
				expected(kind, ref, value, name, "https://shop.example.com/cart?x=1")
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
