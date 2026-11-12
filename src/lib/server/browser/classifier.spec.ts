import { describe, expect, it } from "vitest";
import type { BrowserAction, SnapshotElement } from "./contract";
import {
	actionDigest,
	classifyAction,
	describeAction,
	nameMeansCommit,
	sameSite,
	siteOf,
	type ActionClass,
	type CommitReason,
} from "./classifier";

const el = (over: Partial<SnapshotElement> & { ref?: string }): SnapshotElement => ({
	ref: "e1",
	role: "button",
	name: "",
	...over,
});

type Row = {
	label: string;
	action: BrowserAction;
	element?: SnapshotElement;
	url?: string;
	expect: ActionClass;
	reason?: CommitReason;
};

const SHOP = "https://shop.example.com/cart";

const rows: Row[] = [
	// read
	{ label: "scroll", action: { type: "scroll", direction: "down" }, expect: "read" },
	{ label: "wait", action: { type: "wait_for", ms: 500 }, expect: "read" },
	{
		label: "navigate within the site",
		action: { type: "navigate", url: "https://shop.example.com/products?page=2" },
		expect: "read",
	},
	{
		label: "navigate to a subdomain of the same site",
		action: { type: "navigate", url: "https://www.example.com/help" },
		expect: "read",
	},
	{
		label: "navigate by a relative path",
		action: { type: "navigate", url: "/orders" },
		expect: "read",
	},
	{
		label: "navigate from a blank tab",
		action: { type: "navigate", url: "https://shop.example.com/" },
		url: "about:blank",
		expect: "read",
	},
	{
		label: "plain link on the same site",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Product details", href: "/p/1" }),
		expect: "read",
	},
	{
		label: "a tab",
		action: { type: "click", ref: "e1" },
		element: el({ role: "tab", name: "Reviews" }),
		expect: "read",
	},
	{
		label: "add to cart is not a purchase",
		action: { type: "click", ref: "e1" },
		element: el({ name: "Add to cart" }),
		expect: "read",
	},
	{
		label: "payment methods is a heading-like link, not a verb",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Payment methods" }),
		expect: "read",
	},
	{
		label: "sign in link is not signing a document",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Sign in" }),
		expect: "read",
	},
	// input
	{
		label: "typing in a field",
		action: { type: "fill", ref: "e1", text: "red shoes" },
		element: el({ role: "textbox", name: "Search" }),
		expect: "input",
	},
	{
		label: "typing in a password field",
		action: { type: "fill", ref: "e1", text: "x" },
		element: el({ role: "textbox", name: "Password", inputType: "password" }),
		expect: "input",
	},
	{
		label: "choosing an option",
		action: { type: "select", ref: "e1", value: "Size 42" },
		element: el({ role: "combobox", name: "Order by" }),
		expect: "input",
	},
	{
		label: "pressing a non-Enter key",
		action: { type: "press", key: "Tab" },
		expect: "input",
	},
	{
		label: "Enter in a field that is not in a form",
		action: { type: "press", key: "Enter", ref: "e1" },
		element: el({ role: "textbox", name: "Search" }),
		expect: "input",
	},
	{
		label: "submitting a search form (GET)",
		action: { type: "click", ref: "e1" },
		element: el({ name: "Search", submits: true, formMethod: "get" }),
		expect: "read",
	},
	{
		label: "typing then Enter in a search box (GET)",
		action: { type: "fill", ref: "e1", text: "x", submit: true },
		element: el({ role: "textbox", name: "Search", form: "f1", formMethod: "get" }),
		expect: "read",
	},
	{
		label: "Enter in a GET form field",
		action: { type: "press", key: "Enter", ref: "e1" },
		element: el({ role: "textbox", name: "Search", form: "f1", formMethod: "get" }),
		expect: "read",
	},
	{
		label: "a GET form's button that sends something is still a commit",
		action: { type: "click", ref: "e1" },
		element: el({ name: "Send", submits: true, formMethod: "get" }),
		expect: "commit",
		reason: "submit",
	},
	{
		label: "a POST form's submit",
		action: { type: "click", ref: "e1" },
		element: el({ name: "Search", submits: true, formMethod: "post" }),
		expect: "commit",
		reason: "submit",
	},
	// commit: submit
	{
		label: "a submit control",
		action: { type: "click", ref: "e1" },
		element: el({ name: "Continue", submits: true }),
		expect: "commit",
		reason: "submit",
	},
	{
		label: "typing then Enter",
		action: { type: "fill", ref: "e1", text: "x", submit: true },
		element: el({ role: "textbox", name: "Search" }),
		expect: "commit",
		reason: "submit",
	},
	{
		label: "Enter in a form field",
		action: { type: "press", key: "Enter", ref: "e1" },
		element: el({ role: "textbox", name: "Email", form: "f1" }),
		expect: "commit",
		reason: "submit",
	},
	// commit: verbs, in several languages
	...[
		["Pay €120", "en"],
		["Buy now", "en"],
		["Place order", "en"],
		["Send message", "en"],
		["Delete account", "en"],
		["Remove item", "en"],
		["Confirm", "en"],
		["Publish", "en"],
		["Sign the contract", "en"],
		["Paga", "it"],
		["Paga ora €120", "it"],
		["Invia", "it"],
		["Elimina", "it"],
		["Conferma", "it"],
		["Acquista", "it"],
		["Conferma l'ordine", "it"],
		["Pagar", "es"],
		["Supprimer", "fr"],
		["Bestätigen", "de"],
		["Réserver", "fr"],
	].map(([name, lang]): Row => ({
		label: `verb: ${name} (${lang})`,
		action: { type: "click", ref: "e1" },
		element: el({ name }),
		expect: "commit",
		reason: "verb",
	})),
	{
		label: "a link whose name is a verb",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Delete this post" }),
		expect: "commit",
		reason: "verb",
	},
	// commit: download
	{
		label: "a download link",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Invoice March", download: true }),
		expect: "commit",
		reason: "download",
	},
	// commit: new domain
	{
		label: "navigate to another site",
		action: { type: "navigate", url: "https://other.example.org/" },
		expect: "commit",
		reason: "new-domain",
	},
	{
		label: "a link that leaves the site",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Our partner", linkDomain: "partner.test" }),
		expect: "commit",
		reason: "new-domain",
	},
	{
		label: "a link whose href leaves the site",
		action: { type: "click", ref: "e1" },
		element: el({ role: "link", name: "Docs", href: "https://docs.vendor.io/start" }),
		expect: "commit",
		reason: "new-domain",
	},
	{
		label: "navigate to a javascript: address",
		action: { type: "navigate", url: "javascript:alert(1)" },
		expect: "commit",
		reason: "bad-url",
	},
	{
		label: "navigate to a file: address",
		action: { type: "navigate", url: "file:///etc/passwd" },
		expect: "commit",
		reason: "bad-url",
	},
	// fail closed
	{
		label: "a click on an element nobody has seen",
		action: { type: "click", ref: "e99" },
		expect: "commit",
		reason: "unknown-element",
	},
];

describe("classifyAction", () => {
	it.each(rows)("$label", (row) => {
		const result = classifyAction(row.action, {
			element: row.element,
			currentUrl: row.url ?? SHOP,
		});
		expect(result.class).toBe(row.expect);
		if (row.reason) expect(result.reason).toBe(row.reason);
	});

	it("reports where a leaving navigation goes", () => {
		expect(
			classifyAction({ type: "navigate", url: "https://other.example.org/x" }, { currentUrl: SHOP })
		).toMatchObject({ class: "commit", reason: "new-domain", targetHost: "other.example.org" });
	});
});

describe("nameMeansCommit", () => {
	it("ignores accents and case", () => {
		expect(nameMeansCommit("CONFIRMER")).toBe(true);
		expect(nameMeansCommit("Bestätigen")).toBe(true);
		expect(nameMeansCommit("Löschen")).toBe(true);
	});
	it("matches whole words only", () => {
		expect(nameMeansCommit("Payments overview")).toBe(false);
		expect(nameMeansCommit("Sender settings")).toBe(false);
		expect(nameMeansCommit("Booking history")).toBe(false);
	});
	it("treats sign in, sign up and log in as not signing", () => {
		expect(nameMeansCommit("Sign in")).toBe(false);
		expect(nameMeansCommit("Sign up")).toBe(false);
		expect(nameMeansCommit("Sign here")).toBe(true);
	});
	it("says no to an empty name", () => {
		expect(nameMeansCommit("")).toBe(false);
	});
});

describe("sites", () => {
	it("compares registrable domains", () => {
		expect(siteOf("shop.example.com")).toBe("example.com");
		expect(siteOf("a.b.example.co.uk")).toBe("example.co.uk");
		expect(sameSite("www.example.com", "shop.example.com")).toBe(true);
		expect(sameSite("example.com", "example.org")).toBe(false);
		expect(sameSite("a.example.co.uk", "b.example.co.uk")).toBe(true);
		expect(sameSite("a.co.uk", "b.co.uk")).toBe(false);
	});
});

describe("describeAction", () => {
	it("names the element and the site", () => {
		expect(
			describeAction(
				{ type: "click", ref: "e1" },
				{ element: el({ name: "Pay €120" }), currentUrl: "https://shop.example.com/checkout" }
			)
		).toBe("Click 'Pay €120' on shop.example.com");
	});
	it("says download for a download", () => {
		expect(
			describeAction(
				{ type: "click", ref: "e1" },
				{
					element: el({ role: "link", name: "invoice.pdf", download: true }),
					currentUrl: SHOP,
				}
			)
		).toBe("Download 'invoice.pdf' from shop.example.com");
	});
	it("says where a navigation leads", () => {
		expect(
			describeAction({ type: "navigate", url: "https://other.example.org/x" }, { currentUrl: SHOP })
		).toBe("Open other.example.org from shop.example.com");
	});
	it("does not invent a name for an unseen element", () => {
		expect(describeAction({ type: "click", ref: "e9" }, { currentUrl: SHOP })).toBe(
			"Click an element on shop.example.com"
		);
	});
	it("shortens a long name", () => {
		const sentence = describeAction(
			{ type: "click", ref: "e1" },
			{ element: el({ name: "x".repeat(300) }), currentUrl: SHOP }
		);
		expect(sentence.length).toBeLessThan(140);
		expect(sentence).toContain("…");
	});
});

describe("actionDigest", () => {
	const click: BrowserAction = { type: "click", ref: "e1" };
	const ctx = { element: el({ name: "Pay €120" }), currentUrl: SHOP };
	it("is stable for the same action", () => {
		expect(actionDigest(click, ctx)).toBe(actionDigest({ ...click }, { ...ctx }));
	});
	it("changes with the element's name, the ref, the action and the origin", () => {
		const base = actionDigest(click, ctx);
		expect(actionDigest(click, { ...ctx, element: el({ name: "Pay €999" }) })).not.toBe(base);
		expect(actionDigest({ type: "click", ref: "e2" }, ctx)).not.toBe(base);
		expect(actionDigest(click, { ...ctx, currentUrl: "https://evil.example.net/cart" })).not.toBe(
			base
		);
		expect(actionDigest({ type: "fill", ref: "e1", text: "x" }, ctx)).not.toBe(base);
	});
	it("ignores the path, which changes without changing what is asked", () => {
		expect(actionDigest(click, { ...ctx, currentUrl: "https://shop.example.com/other" })).toBe(
			actionDigest(click, ctx)
		);
	});
});
