import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	RESULT_LIMIT,
	SNAPSHOT_NOTE,
	WIRE_BUDGET,
	boundDiff,
	boundExtract,
	boundSnapshot,
	bytesOf,
} from "../src/budget.ts";
import { createServer, createToolHandler } from "../src/server.ts";
import { rig, type Rig } from "./helpers.ts";

/** What the server sends for a JSON value: both copies of it. */
const wire = (value: object) =>
	bytesOf({
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
	});

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
		const fence = (t: string) => `<page-content untrusted="true">\n${t}</page-content>`;
		const snap = {
			url: "http://x/",
			title: "t",
			text: fence(line.repeat(8000)),
			elements: Array.from({ length: 2000 }, (_, i) => ({
				ref: `e${i}`,
				role: "link",
				name: "n".repeat(300),
			})),
		} as never;
		const out = boundSnapshot(snap, wire) as { text: string; truncated?: boolean; note?: string };
		assert.ok(wire(out) <= WIRE_BUDGET);
		assert.ok(out.text.startsWith(SNAPSHOT_NOTE), "the note comes first");
		assert.ok(out.text.trimEnd().endsWith("</page-content>"), "the closing fence is kept");
		assert.equal(out.truncated, true);
		assert.match(out.note ?? "", /Scroll .* extract/);
		const diff = boundDiff(
			{
				url: "http://x/",
				title: "t",
				navigated: true,
				added: [],
				changed: [],
				removed: [],
				text: line.repeat(8000),
				snapshot: snap,
			} as never,
			wire
		);
		assert.ok(wire(diff) <= WIRE_BUDGET);
		assert.match(diff.text, /truncated/);
	});

	it("quote- and backslash-heavy pages are bounded on the escaped wire size", async () => {
		await r.goto("/quotes");
		for (const [tool, args] of [
			["snapshot", {}],
			["diff", {}],
			["extract", {}],
			["extract", { mode: "text" }],
		] as const) {
			const res = await r.call(tool, args);
			assert.notEqual(
				res.isError,
				true,
				`${tool}: ${(res.content[0] as { text: string }).text.slice(0, 200)}`
			);
			assert.ok(bytesOf(res) <= RESULT_LIMIT, `${tool} ${bytesOf(res)} bytes`);
		}
		// The unit: a text that is mostly quotes doubles on the text copy.
		const nasty = '"\\'.repeat(200_000);
		const snap = boundSnapshot(
			{ url: "http://x/", title: "t", text: nasty, elements: [] } as never,
			wire
		);
		assert.ok(wire(snap) <= WIRE_BUDGET, `${wire(snap)}`);
		const ex = boundExtract(
			{
				tables: [],
				lists: [{ items: Array.from({ length: 1000 }, () => nasty.slice(0, 1500)) }],
			} as never,
			wire
		);
		assert.ok(wire(ex) <= WIRE_BUDGET);
		assert.ok(Object.keys(ex)[0] === "note", "the note is the first key");
	});

	it("a diff that cannot be cut part by part comes back as a bounded full snapshot", async () => {
		await r.goto("/form");
		await r.snapshot();
		// The page changes a lot at once, past what one result can carry.
		await r.session
			.act([{ type: "navigate", url: `${r.fx.base}/form` }] as never, undefined)
			.catch(() => undefined);
		await r.snapshot();
		const page = (
			r.session as unknown as { livePage(): { evaluate(f: string): Promise<void> } }
		).livePage();
		await page.evaluate(
			`document.body.innerHTML = Array.from({length: 4000}, (_, i) => '<p><a href="/z' + i + '">' + 'w'.repeat(300) + i + '</a></p>').join('')`
		);
		const res = await r.call("diff", {});
		assert.notEqual(res.isError, true);
		assert.ok(bytesOf(res) <= RESULT_LIMIT);
		const d = res.structuredContent as { navigated: boolean; snapshot?: { truncated?: boolean } };
		assert.equal(d.navigated, true);
		assert.equal(d.snapshot?.truncated, true);
	});

	it("download returns what fits, keeps the rest for the next call and lets go of what never fits", async () => {
		const dir = join(r.profile, "dl");
		await mkdir(dir, { recursive: true });
		const mk = async (name: string, size: number) => {
			const path = join(dir, name);
			await writeFile(path, Buffer.alloc(size, 7));
			return { name, mime: "application/octet-stream", size, path, actionIndex: 0, grantId: "g" };
		};
		const files = [
			await mk("a.bin", 150_000),
			await mk("b.bin", 150_000),
			await mk("c.bin", 600_000),
		];
		(r.session as unknown as { downloads: unknown[] }).downloads = files;
		const res = await r.call("download", {});
		assert.notEqual(res.isError, true);
		assert.ok(bytesOf(res) <= RESULT_LIMIT, `${bytesOf(res)}`);
		const got = (
			res.structuredContent as { files: Array<{ name: string; base64?: string; skipped?: string }> }
		).files;
		const by = Object.fromEntries(got.map((f) => [f.name, f]));
		assert.ok(by["a.bin"].base64);
		assert.equal(by["b.bin"].base64, undefined);
		assert.equal(by["b.bin"].skipped, "too large for one result; call download again");
		assert.match(by["c.bin"].skipped ?? "", /too large to return over the link/);
		// b stays for the next call; c is gone.
		const again = (await r.call("download", {})).structuredContent as {
			files: Array<{ name: string; base64?: string }>;
		};
		assert.deepEqual(
			again.files.map((f) => f.name),
			["b.bin"]
		);
		assert.ok(again.files[0].base64);
		assert.deepEqual(
			((await r.call("download", {})).structuredContent as { files: unknown[] }).files,
			[]
		);
	});

	it("an oversize download-shaped result gets an error that does not say to scroll", async () => {
		const fake = {
			serial: <T>(w: () => Promise<T>) => w(),
			download: async () => ({ files: [{ name: "a", size: 1, base64: "x".repeat(1_000_000) }] }),
		};
		const res = await createToolHandler(fake as never)("download", {});
		const text = (res.content[0] as { text: string }).text;
		assert.match(text, /call download again/);
		assert.doesNotMatch(text, /scroll/);
	});

	it("a second client on the same process starts clean: no refs, baseline or downloads; pages stay", async () => {
		await r.goto("/form");
		const priv = r.session as unknown as {
			downloads: unknown[];
			baseline: unknown;
			acting: boolean;
		};
		priv.downloads = [{ name: "x", mime: "x", size: 1, actionIndex: 0 }];
		priv.acting = true;
		assert.ok(priv.baseline);
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const server = createServer(r.session);
		await server.connect(serverSide);
		const pending = new Map<number, (m: unknown) => void>();
		clientSide.onmessage = (m) => {
			const id = (m as { id?: number }).id;
			if (id !== undefined) pending.get(id)?.(m);
		};
		await clientSide.start();
		let next = 0;
		const rpc = (method: string, params: Record<string, unknown>) =>
			new Promise<unknown>((ok) => {
				const id = ++next;
				pending.set(id, ok);
				void clientSide.send({ jsonrpc: "2.0", id, method, params });
			});
		const hello = async () => {
			await rpc("initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "t", version: "1" },
			});
			await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		};
		await hello();
		assert.ok(priv.baseline, "the first client changes nothing");
		await hello();
		await rpc("tools/call", { name: "tabs", arguments: {} }); // after the reset in the queue
		assert.deepEqual(priv.downloads, []);
		assert.equal(priv.baseline, undefined);
		assert.equal(priv.acting, false);
		const tabs = await r.tabs();
		assert.ok(
			tabs.tabs.some((t) => t.url.includes("/form")),
			"the page stays open"
		);
		await server.close();
	});

	it("a file of about 250 KB still comes back whole", async () => {
		const dir = join(r.profile, "dl2");
		await mkdir(dir, { recursive: true });
		const path = join(dir, "big.bin");
		await writeFile(path, Buffer.alloc(250_000, 3));
		(r.session as unknown as { downloads: unknown[] }).downloads = [
			{ name: "big.bin", mime: "application/octet-stream", size: 250_000, path, actionIndex: 0 },
		];
		const res = await r.call("download", {});
		const got = (res.structuredContent as { files: Array<{ base64?: string }> }).files;
		assert.equal(got.length, 1);
		assert.ok(got[0].base64);
		assert.ok(bytesOf(res) <= RESULT_LIMIT);
	});

	it("many big tables are all cut, none emptied while another keeps everything", () => {
		const row = Array.from({ length: 5 }, () => "c".repeat(1500));
		const tables = Array.from({ length: 10 }, () => ({
			headers: [],
			rows: Array.from({ length: 300 }, () => row),
		}));
		const out = boundExtract({ tables, lists: [] } as never, wire);
		assert.ok(wire(out) <= WIRE_BUDGET);
		for (const t of out.tables) assert.ok(t.rows.length >= 1, "every table keeps some rows");
		const lens = out.tables.map((t) => t.rows.length);
		assert.ok(Math.max(...lens) <= 2 * Math.min(...lens) + 1, `uneven cut ${lens}`);
	});
});
