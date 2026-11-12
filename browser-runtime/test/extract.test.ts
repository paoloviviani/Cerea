import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("extract", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("reads a long table as rows under their column headers, in full", async () => {
		await r.goto("/table");
		const out = await r.extract({});
		assert.equal(out.tables.length, 1);
		const t = out.tables[0];
		assert.equal(t.caption, "Staff");
		assert.deepEqual(t.headers, ["ID", "Name", "Dept", "Salary"]);
		assert.equal(t.rows.length, 200);
		assert.deepEqual(t.rows[0], ["1", "Person 1", "Ops", "40000"]);
		assert.deepEqual(t.rows[199].slice(0, 2), ["200", "Person 200"]);
		assert.equal(t.truncated, undefined);
		assert.equal(out.text, undefined, "no text for the whole page unless asked");
	});

	it("reads lists and definition lists", async () => {
		await r.goto("/lists");
		const out = await r.extract({ mode: "lists" });
		assert.equal(out.tables.length, 0);
		assert.equal(out.lists[0].items.length, 12);
		assert.equal(out.lists[0].items[11], "Task 12");
		assert.deepEqual(out.lists[1].items, ["Colour: Blue", "Size: Large"]);
	});

	it("reads the text of a region by ref", async () => {
		const snap = await r.goto("/form");
		const out = await r.extract({ ref: r.ref(snap, "button", "Save"), mode: "text" });
		assert.equal(out.text, "Save");
		const all = await r.extract({ mode: "text" });
		assert.match(all.text ?? "", /Contact form/);
	});

	it("takes the contract's request, bare or nested under schema, and tolerates strings", async () => {
		await r.goto("/list");
		const bare = await r.extract({ mode: "tables" });
		const nested = await r.extract({ schema: { mode: "tables" } });
		const asString = await r.extract({ schema: JSON.stringify({ mode: "tables" }) });
		assert.deepEqual(nested, bare);
		assert.deepEqual(asString, bare);
		assert.equal(bare.tables[0].rows.length, 10);
		assert.equal(bare.tables[0].rows[9][1], "SKU-1009");
		// A real JSON Schema is ignored, not an error: the sub-agent maps the data.
		const schema = await r.extract({ schema: { type: "object", properties: { rows: { type: "array" } } } });
		assert.equal(schema.tables.length, 1);
	});

	it("explains a bad request or a stale ref", async () => {
		await r.goto("/list");
		const bad = await r.call("extract", { mode: "everything" });
		assert.equal(bad.isError, true);
		assert.match(String(bad.content[0].type === "text" && bad.content[0].text), /mode/);
		const stale = await r.call("extract", { ref: "e9999" });
		assert.equal(stale.isError, true);
		assert.match(String(stale.content[0].type === "text" && stale.content[0].text), /No element with ref e9999/);
	});

	it("returns clean strings: no zero-width or tag characters", async () => {
		const snap = await r.goto("/inject");
		const out = await r.extract({ mode: "text" });
		assert.ok(snap.url);
		assert.doesNotMatch(out.text ?? "", /[​\u{e0000}-\u{e007f}]/u);
	});
});
