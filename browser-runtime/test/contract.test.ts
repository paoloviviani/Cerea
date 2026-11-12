import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { signGrant } from "../src/grants.ts";
import { parseKey } from "../src/keys.ts";
import { TEST_KEY, rig, type Rig } from "./helpers.ts";

describe("signed grants", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	const save = async () => {
		const snap = await r.goto("/form");
		const action = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		return { snap, action };
	};

	it("refuses a grant signed with another key, an expired one, and one with a changed digest", async () => {
		const { snap, action } = await save();
		const posts = r.fx.hits.posts.length;
		const wrongKey = r.grant(snap, action, 0, undefined, { key: Buffer.from("another-device-key-another-device") });
		const a = await r.act([action], [wrongKey]);
		assert.equal(a.results[0].refused, "approval_mismatch");
		assert.match(a.results[0].error ?? "", /signature/);
		const expired = r.grant(snap, action, 0, undefined, { exp: Date.now() - 1000 });
		const b = await r.act([action], [expired]);
		assert.equal(b.results[0].refused, "approval_mismatch");
		assert.equal(b.results[0].refused, "approval_expired");
		// A forged digest with a signature that matches it (a signer that signed another action).
		const other = { ...r.grant(snap, { type: "click", ref: "e999" }) };
		const c = await r.act([action], [other]);
		assert.equal(c.results[0].refused, "approval_mismatch");
		// The digest edited after signing breaks the signature.
		const good = r.grant(snap, action);
		const d = await r.act([action], [{ ...good, digest: "f".repeat(32) }]);
		assert.equal(d.results[0].refused, "approval_mismatch");
		// A signature over a different id.
		const e = await r.act([action], [{ ...good, id: "another-id" }]);
		assert.equal(e.results[0].refused, "approval_mismatch");
		assert.equal(r.fx.hits.posts.length, posts);
		assert.equal(good.sig, signGrant(TEST_KEY, good.id, good.digest, good.exp));
		assert.match(good.sig, /^[0-9a-f]{64}$/);
		assert.equal((await r.act([action], [good])).results[0].ok, true);
	});

	it("accepts nothing when the runtime has no key", async () => {
		const { snap, action } = await save();
		const grant = r.grant(snap, action);
		const keyless = await rig();
		try {
			await keyless.session.close();
			(keyless.session as unknown as { options: { keyFile?: string } }).options.keyFile = "/nonexistent/key";
			const snap2 = await keyless.goto("/form");
			const act2 = { type: "click" as const, ref: keyless.ref(snap2, "button", "Save") };
			const res = await keyless.act([act2], [keyless.grant(snap2, act2)]);
			assert.equal(res.results[0].refused, "approval_required");
			assert.match(res.results[0].error ?? "", /no approval key/);
		} finally {
			await keyless.close();
		}
		assert.ok(grant.sig);
	});
});

describe("keys, navigation and downloads", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("normalises key names", () => {
		assert.deepEqual(parseKey("NumpadEnter"), { base: "Enter", modifiers: [] });
		assert.deepEqual(parseKey("Return"), { base: "Enter", modifiers: [] });
		assert.deepEqual(parseKey(" "), { base: "Space", modifiers: [] });
		assert.deepEqual(parseKey("Control+Enter"), { base: "Enter", modifiers: ["Control"] });
		assert.deepEqual(parseKey("Shift+Space"), { base: "Space", modifiers: ["Shift"] });
		assert.deepEqual(parseKey("Tab"), { base: "Tab", modifiers: [] });
	});

	it("makes Enter, Space (no ref) and modified Enter commit-class, whatever the spelling", async () => {
		const snap = await r.goto("/form");
		const field = r.ref(snap, "textbox", "Full name");
		await r.act([{ type: "click", ref: field }]);
		const posts = r.fx.hits.posts.length;
		for (const key of ["Enter", "NumpadEnter", "Return", " ", "Space", "Control+Enter", "Shift+Enter"]) {
			const res = await r.act([{ type: "press", key }]);
			assert.equal(res.results[0].refused, "approval_required", key);
		}
		const modified = await r.act([{ type: "press", key: "Shift+Enter", ref: field }]);
		assert.equal(modified.results[0].refused, "approval_required");
		const space = await r.act([{ type: "press", key: " ", ref: r.ref(snap, "button", "Save") }]);
		assert.equal(space.results[0].refused, "approval_required", "Space presses a submit button");
		assert.equal(r.fx.hits.posts.length, posts);
		assert.equal((await r.act([{ type: "press", key: "Tab" }])).results[0].ok, true);
		assert.equal((await r.act([{ type: "press", key: "Shift+Tab" }])).results[0].ok, true);
	});

	it("reports where a form would send its data", async () => {
		const snap = await r.goto("/xform");
		const go = r.element(snap, r.ref(snap, "button", "Go"));
		assert.equal(go.formActionHost, "localhost");
		assert.equal(go.formMethod, "get");
		const form = await r.goto("/form");
		const own = r.element(form, r.ref(form, "button", "Save"));
		assert.equal(own.formActionHost, "127.0.0.1");
	});

	it("reports a navigation that a fill caused", async () => {
		const snap = await r.goto("/xform");
		const res = await r.act([{ type: "fill", ref: r.ref(snap, "textbox", "Auto"), text: "x" }]);
		assert.equal(res.results[0].ok, true);
		assert.match(res.results[0].outcome ?? "", /the page navigated to http:\/\/127\.0\.0\.1:\d+\/list/);
		assert.equal(res.url, `${r.fx.base}/list`);
	});

	it("never goes to a local file, from a link or from the page's own script", async () => {
		const snap = await r.goto("/xform");
		const link = { type: "click" as const, ref: r.ref(snap, "link", "Local file") };
		for (const action of [link, { type: "click" as const, ref: r.ref(snap, "button", "Open local") }]) {
			// Even with a signed grant for exactly this action.
			const res = await r.act([action], [r.grant(snap, action)]);
			assert.match(res.url, /^http:/, JSON.stringify(res));
		}
		const nav = { type: "navigate" as const, url: "file:///etc/hostname" };
		const res = await r.act([nav], [r.grant(snap, nav)]);
		assert.equal(res.results[0].ok, false);
		assert.equal(res.results[0].refused, "scheme_refused");
		assert.match(res.url, /^http:/);
	});

	it("caps a batch at 12 actions, and runs none of a longer one", async () => {
		await r.goto("/form");
		const many = Array.from({ length: 13 }, () => ({ type: "scroll" as const, direction: "down" as const }));
		const res = await r.call("act", { actions: many });
		assert.equal(res.isError, true);
		assert.match(String(res.content[0].type === "text" && res.content[0].text), /At most 12/);
		const twelve = await r.act(many.slice(0, 12));
		assert.equal(twelve.results.length, 12);
	});

	it("tags a download with the action and grant that produced it, and keeps back the rest", async () => {
		const snap = await r.goto("/downloads");
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Report (CSV)") };
		const grant = r.grant(snap, click, 0, "elicitation-xyz");
		const res = await r.act([{ type: "scroll", direction: "down" }, click], [{ ...grant, index: 1 }]);
		assert.equal(res.results[1].ok, true, JSON.stringify(res));
		// A download the page starts long after the action (a timer) has no provenance.
		await new Promise((ok) => setTimeout(ok, 1200));
		await r.session.withPage((page) =>
			page.evaluate(() => {
				const a = document.createElement("a");
				a.href = URL.createObjectURL(new Blob(["x"], { type: "text/plain" }));
				a.download = "unprompted.txt";
				a.click();
			})
		);
		await new Promise((ok) => setTimeout(ok, 500));
		const got = await r.download();
		assert.equal(got.files.length, 1);
		assert.deepEqual(
			[got.files[0].name, got.files[0].actionIndex, got.files[0].grantId],
			["report.csv", 1, "elicitation-xyz"]
		);
		assert.deepEqual(res.downloads, [{ name: "report.csv", mime: "text/csv", actionIndex: 1, grantId: "elicitation-xyz" }]);
		const all = await (async () => {
			const out = await r.call("download", { all: true });
			return JSON.parse((out.content[0] as { text: string }).text).files as Array<{ name: string; actionIndex?: number }>;
		})();
		assert.deepEqual(all.map((f) => [f.name, f.actionIndex]), [["unprompted.txt", undefined]]);
	});
});
