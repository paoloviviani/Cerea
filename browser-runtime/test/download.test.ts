import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("downloads", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("refuses a download link without an approval, and captures it with one", async () => {
		const snap = await r.goto("/downloads");
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Report (CSV)") };
		const refused = await r.act([click]);
		assert.equal(refused.results[0].refused, "approval_required");
		assert.deepEqual((await r.download()).files, []);
		const res = await r.act([click], [r.grant(snap, click)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.deepEqual(res.downloads, [{ name: "report.csv", mime: "text/csv" }]);
		const got = await r.download();
		assert.equal(got.files.length, 1);
		assert.equal(got.files[0].name, "report.csv");
		assert.equal(got.files[0].mime, "text/csv");
		assert.equal(got.files[0].size, 8);
		assert.equal(Buffer.from(got.files[0].base64!, "base64").toString(), "a,b\n1,2\n");
		assert.equal(res.url, snap.url, "the page stays where it was");
		assert.deepEqual((await r.download()).files, [], "taking the files clears them");
	});

	it("captures an attachment served for a file-type link", async () => {
		const snap = await r.goto("/downloads");
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Plain file link") };
		const res = await r.act([click], [r.grant(snap, click)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		const got = await r.download();
		assert.equal(got.files[0].name, "data.bin");
		assert.deepEqual([...Buffer.from(got.files[0].base64!, "base64")], [0, 1, 2, 3, 4, 5]);
	});

	it("captures a file made by the page itself", async () => {
		const snap = await r.goto("/downloads");
		const res = await r.act([{ type: "click", ref: r.ref(snap, "button", "Export now") }]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		const got = await r.download();
		assert.equal(got.files[0].name, "blob.csv");
		assert.equal(Buffer.from(got.files[0].base64!, "base64").toString(), "hello,world\n");
	});

	it("starting a download by navigating to it is a download, not an error", async () => {
		await r.goto("/downloads");
		const res = await r.act([{ type: "navigate", url: "/files/report.csv" }]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.equal((await r.download()).files[0].name, "report.csv");
	});
});
