import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("human-verification steps", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
		// The google.com frame of the reCAPTCHA fixture is answered here and goes nowhere.
		await r.session.withPage(async (page) => {
			await page.route("https://www.google.com/**", (route) =>
				route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" })
			);
		});
	});
	after(() => r.close());

	for (const [kind, want] of [
		["recaptcha", "recaptcha"],
		["hcaptcha", "hcaptcha"],
		["turnstile", "turnstile"],
		["iframe", "recaptcha"],
		["cloudflare", "cloudflare"],
		["text", "human-check"],
	] as const) {
		it(`reports ${want} in the snapshot and the diff (${kind})`, async () => {
			const snap = await r.goto(`/challenge?kind=${kind}`);
			assert.deepEqual(snap.challenge, { kind: want });
			assert.match(snap.text, new RegExp(`^challenge: ${want} \\(a human-verification step`, "m"));
			const diff = await r.diff();
			assert.deepEqual(diff.challenge, { kind: want });
		});
	}

	it("reports nothing on an ordinary page", async () => {
		const snap = await r.goto("/challenge?kind=none");
		assert.equal(snap.challenge, undefined);
		assert.ok(!/^challenge:/m.test(snap.text));
		const form = await r.goto("/form");
		assert.equal(form.challenge, undefined);
	});

	it("refuses to act on a widget, even with a signed grant, and acts on the rest", async () => {
		for (const [kind, name] of [
			["recaptcha", "I am not a robot"],
			["hcaptcha", "Check the box"],
			["turnstile", "Verify"],
		] as const) {
			const snap = await r.goto(`/challenge?kind=${kind}`);
			const click = { type: "click" as const, ref: r.ref(snap, "button", name) };
			const res = await r.act([click], [r.grant(snap, click)]);
			assert.equal(res.results[0].ok, false, kind);
			assert.equal(res.results[0].refused, "challenge", kind);
			assert.match(res.results[0].error ?? "", /user has to solve it/);
			const fill = await r.act([{ type: "press", key: "Tab", ref: click.ref }]);
			assert.equal(fill.results[0].refused, "challenge", kind);
		}
		const snap = await r.goto("/challenge?kind=recaptcha");
		const plain = await r.act([{ type: "click", ref: r.ref(snap, "button", "Plain button") }]);
		assert.equal(plain.results[0].ok, true, "a button beside the widget is not the widget");
		assert.equal(plain.title, "plain-clicked");
	});

	it("refuses the frame of a reCAPTCHA by its address", async () => {
		const snap = await r.goto("/challenge?kind=iframe");
		const frame = snap.elements.find((e) => e.role === "iframe" || /recaptcha/i.test(e.name));
		if (frame) {
			const res = await r.act([{ type: "click", ref: frame.ref }]);
			assert.equal(res.results[0].refused, "challenge");
		} else {
			assert.deepEqual(
				snap.challenge,
				{ kind: "recaptcha" },
				"the widget is reported even when its frame has no ref"
			);
		}
	});
});
