import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("diff and refs", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("keeps refs stable across fills, and diff reports only the changed field", async () => {
		const before = await r.goto("/form");
		const name = r.ref(before, "textbox", "Full name");
		const email = r.ref(before, "textbox", "Email");
		const save = r.ref(before, "button", "Save");
		const res = await r.act([{ type: "fill", ref: name, text: "Ada Lovelace" }]);
		assert.equal(res.results[0].ok, true);
		const d = await r.diff();
		assert.equal(d.navigated, false);
		assert.deepEqual(d.added, []);
		assert.deepEqual(d.removed, []);
		assert.deepEqual(
			d.changed.map((e) => [e.ref, e.value]),
			[[name, "Ada Lovelace"]]
		);
		assert.match(d.text, /^~ \[e\d+\] textbox "Full name" value="Ada Lovelace"$/m);
		assert.equal(d.url, `${r.fx.base}/form`);
		assert.equal(d.title, "Contact form");
		// More fills: the other refs do not move.
		await r.act([{ type: "fill", ref: email, text: "ada@example.test" }]);
		const after = await r.snapshot();
		assert.equal(r.ref(after, "textbox", "Full name"), name);
		assert.equal(r.ref(after, "textbox", "Email"), email);
		assert.equal(r.ref(after, "button", "Save"), save);
	});

	it("ignores which field has focus", async () => {
		const snap = await r.goto("/form");
		await r.act([{ type: "press", key: "Tab" }]);
		const d1 = await r.diff();
		await r.act([{ type: "press", key: "Tab" }]);
		const d2 = await r.diff();
		assert.equal(snap.url, d1.url);
		for (const d of [d1, d2]) {
			assert.deepEqual([d.added, d.changed, d.removed], [[], [], []]);
			assert.match(d.text, /\(no change\)/);
		}
	});

	it("reports added nodes with their metadata and leaves old refs alone", async () => {
		const snap = await r.goto("/dynamic");
		const nameRef = r.ref(snap, "textbox", "Name");
		const show = r.ref(snap, "button", "Show more");
		const res = await r.act([{ type: "click", ref: show }]);
		assert.equal(res.results[0].ok, true);
		const d = await r.diff();
		assert.equal(d.navigated, false);
		assert.equal(d.added.length, 1);
		assert.equal(d.added[0].role, "link");
		assert.equal(d.added[0].name, "Inserted link");
		assert.equal(d.added[0].href, "/form");
		assert.deepEqual(d.removed, []);
		assert.match(d.text, /^\+ \[\S+\] link "Inserted link" → \/form$/m);
		const after = await r.snapshot();
		assert.equal(r.ref(after, "textbox", "Name"), nameRef);
		assert.equal(r.ref(after, "button", "Show more"), show);
	});

	it("sends a full snapshot after navigation, and refs reset", async () => {
		const first = await r.goto("/list");
		const next = r.ref(first, "link", "Next");
		const res = await r.act([{ type: "click", ref: next }]);
		assert.equal(res.results[0].ok, true);
		assert.equal(res.url, `${r.fx.base}/list?page=2`);
		const d = await r.diff();
		assert.equal(d.navigated, true);
		assert.ok(d.snapshot);
		assert.equal(d.snapshot.url, `${r.fx.base}/list?page=2`);
		assert.equal(d.url, d.snapshot.url);
		assert.equal(d.title, "Catalogue");
		assert.match(d.snapshot.text, /Page 2 of 5/);
		assert.deepEqual(d.added, []);
		// An old ref no longer names anything.
		const stale = await r.act([{ type: "click", ref: next }]);
		assert.equal(stale.results[0].ok, false);
		assert.match(stale.results[0].error ?? "", /No element with ref .* take a new snapshot/);
		// And the next diff is relative to the new page.
		const quiet = await r.diff();
		assert.equal(quiet.navigated, false);
		assert.match(quiet.text, /\(no change\)/);
	});

	it("starts with a full snapshot when nothing was taken yet", async () => {
		await r.session.close();
		const fresh = await rig();
		try {
			const d = await fresh.diff();
			assert.equal(d.navigated, true);
			assert.ok(d.snapshot);
		} finally {
			await fresh.close();
		}
	});
});
