import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PAYLOAD_LIMIT, RESULT_LIMIT, boundDiff, boundSnapshot, bytesOf } from "../src/budget.ts";
import { createToolHandler } from "../src/server.ts";
import { rig, type Rig } from "./helpers.ts";

describe("result size", () => {
	let r: Rig;
	before(async () => {
		// A generous snapshot budget, so the page itself is what is big.
		r = await rig({ maxSnapshotChars: 200_000 });
	});
	after(() => r.close());

	it("a huge page's snapshot and diff stay under the limit and say what to do", async () => {
		await r.goto("/huge");
		const res = await r.call("snapshot", {});
		assert.ok(bytesOf(res) <= RESULT_LIMIT, `snapshot ${bytesOf(res)} bytes`);
		assert.notEqual(res.isError, true);
		const snap = res.structuredContent as { text: string; truncated?: boolean; note?: string };
		assert.ok(JSON.stringify(snap).length <= PAYLOAD_LIMIT);
		const diff = await r.call("diff", {});
		assert.ok(bytesOf(diff) <= RESULT_LIMIT, `diff ${bytesOf(diff)} bytes`);
		assert.notEqual(diff.isError, true);
	});

	it("extract of a huge page is capped, counts what it left out and carries a note", async () => {
		await r.goto("/huge");
		const res = await r.call("extract", {});
		assert.ok(bytesOf(res) <= RESULT_LIMIT, `extract ${bytesOf(res)} bytes`);
		assert.notEqual(res.isError, true);
		const out = res.structuredContent as {
			note?: string;
			tables: Array<{ rows: unknown[]; truncated?: number }>;
			lists: Array<{ items: unknown[]; truncated?: number }>;
		};
		assert.match(out.note ?? "", /Narrow down/);
		const t = out.tables[0];
		assert.ok(t.rows.length < 400 && (t.truncated ?? 0) > 0, "table rows cut and counted");
		assert.equal(t.rows.length + (t.truncated ?? 0), 400);
		// Region text too.
		const text = await r.call("extract", { mode: "text" });
		assert.ok(bytesOf(text) <= RESULT_LIMIT);
	});

	it("a screenshot of noise is re-encoded to fit", async () => {
		await r.goto("/noise");
		const res = await r.call("screenshot", {});
		assert.notEqual(res.isError, true);
		assert.ok(bytesOf(res) <= RESULT_LIMIT, `screenshot ${bytesOf(res)} bytes`);
		const img = res.content[0] as { type: string; mimeType: string; data: string };
		assert.equal(img.type, "image");
		assert.equal(img.mimeType, "image/jpeg");
		assert.ok(img.data.length <= 700_000);
	});

	it("the final guard turns any oversize result into a structured error", async () => {
		const big = "x".repeat(1_000_000);
		const fake = {
			serial: <T>(w: () => Promise<T>) => w(),
			download: async () => ({ files: [{ name: "a", size: 1, base64: big }] }),
		};
		const handler = createToolHandler(fake as never);
		const res = await handler("download", {});
		assert.equal(res.isError, true);
		const text = (res.content[0] as { text: string }).text;
		assert.match(text, /^result too large: download, \d+ bytes/);
		assert.match(text, /narrow the request/);
	});

	it("boundSnapshot and boundDiff cut an oversize tree and point to scroll and extract", () => {
		const line = '[e1] link "' + "y".repeat(200) + '"\n';
		const snap = {
			url: "http://x/",
			title: "t",
			text: line.repeat(8000),
			elements: Array.from({ length: 2000 }, (_, i) => ({
				ref: `e${i}`,
				role: "link",
				name: "n".repeat(300),
			})),
		} as never;
		const out = boundSnapshot(snap) as { text: string; truncated?: boolean; note?: string };
		assert.ok(bytesOf(out) <= PAYLOAD_LIMIT);
		assert.equal(out.truncated, true);
		assert.match(out.note ?? "", /Scroll .* extract/);
		const diff = boundDiff({
			url: "http://x/",
			title: "t",
			navigated: true,
			added: [],
			changed: [],
			removed: [],
			text: line.repeat(8000),
			snapshot: snap,
		} as never);
		assert.ok(bytesOf(diff) <= PAYLOAD_LIMIT);
		assert.match(diff.text, /truncated/);
	});
});
