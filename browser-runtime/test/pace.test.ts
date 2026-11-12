import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("pacing", () => {
	const open: Rig[] = [];
	after(async () => {
		for (const r of open) await r.close();
	});
	const scrolls = (n: number) =>
		Array.from({ length: n }, () => ({ type: "scroll", direction: "down" }));

	it("pauses between the actions of a batch and between batches", async () => {
		const r = await rig({ pace: { minMs: 300, maxMs: 300 } });
		open.push(r);
		await r.goto("/long");
		let t = Date.now();
		await r.act(scrolls(3));
		const batch = Date.now() - t;
		assert.ok(batch >= 600, `3 actions took ${batch} ms: two pauses of 300 were expected`);
		// The next batch starts at least a pause after the last one ended.
		t = Date.now();
		await r.act(scrolls(1));
		assert.ok(Date.now() - t >= 250, "no pause between batches");
	});

	it("is random between the bounds", async () => {
		const r = await rig({ pace: { minMs: 100, maxMs: 400 } });
		open.push(r);
		await r.goto("/long");
		const times: number[] = [];
		for (let i = 0; i < 6; i += 1) {
			const t = Date.now();
			await r.act(scrolls(2));
			times.push(Date.now() - t);
		}
		assert.ok(
			times.every((x) => x >= 90),
			`a pause was shorter than the minimum: ${times}`
		);
		assert.ok(new Set(times.map((x) => Math.round(x / 25))).size > 1, `not random: ${times}`);
	});

	it("is off unless asked for", async () => {
		const r = await rig();
		open.push(r);
		await r.goto("/long");
		const t = Date.now();
		await r.act(scrolls(6));
		assert.ok(Date.now() - t < 1500, "pacing was on by default");
	});
});
