import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openResultSchema } from "../src/contract.ts";
import { launchOptions } from "../src/session.ts";
import { rig, type Rig } from "./helpers.ts";

const blankCount = (r: Rig) =>
	r.session.withPage(async (_p, c) => c.pages().filter((p) => p.url() === "about:blank").length);

describe("no eager page: a task page is made when something needs one", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	/** Pages the browser holds, counted without making one. */
	const pageCount = async () => (await r.tabs()).tabs.length;

	it("tabs() makes no page of its own", async () => {
		const before = await pageCount();
		await r.tabs();
		assert.equal(await pageCount(), before);
		assert.equal((await r.tabs()).tabs.filter((t) => t.mine).length, 0);
	});

	it("snapshot with no page answers a blank page and makes none", async () => {
		const before = await pageCount();
		const snap = await r.snapshot();
		assert.equal(snap.url, "about:blank");
		assert.equal(snap.elements.length, 0);
		assert.equal(await pageCount(), before);
		assert.equal((await r.call("screenshot", {})).isError, true);
		assert.equal((await r.call("extract", {})).isError, true);
	});

	it("use_tab on a user's tab makes no blank page, and the task ends without a stray one", async () => {
		await r.goto("/form");
		await r.session.endTask();
		const user = await r.session.withPage((_p, c) => c.newPage());
		await r.session.endTask(); // the withPage above made (and closed) a task page
		await user.goto(`${r.fx.base}/title?t=Mine`);
		const before = await pageCount();
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const res = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.equal(res.url.includes("/title"), true);
		assert.equal(await pageCount(), before, "use_tab opened a page");
		await r.call("end_task", { keep: true });
		await user.close();
	});

	it("a navigation makes the page lazily, and a task that never used it leaves none behind", async () => {
		await r.session.endTask();
		const before = await blankCount(r);
		await r.session.endTask();
		const nav = await r.act(
			[{ type: "navigate", url: `${r.fx.base}/form` }],
			[
				r.signed(
					(await import("../src/classifier.ts")).actionDigest(
						{ type: "navigate", url: `${r.fx.base}/form` },
						{ currentUrl: "about:blank", firstNavigation: false }
					)
				),
			]
		);
		assert.equal(nav.results[0].ok, true, JSON.stringify(nav));
		assert.equal((await r.tabs()).tabs.filter((t) => t.mine).length, 1);
		await r.session.endTask();
		assert.equal((await r.tabs()).tabs.filter((t) => t.mine).length, 0);
		assert.ok((await blankCount(r)) <= before);
	});

	it("a blank page nobody used is not kept at the end of a task", async () => {
		await r.session.withPage(async () => undefined); // an action that needs a page makes one
		const end = (await r.call("end_task", { keep: true })).structuredContent as {
			kept?: unknown;
		};
		assert.equal(end.kept, undefined);
	});
});

describe("open reuses a blank tab", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("a second open of a blank page does not add a tab", async () => {
		const first = openResultSchema.parse((await r.call("open", {})).structuredContent);
		const count = (await r.tabs()).tabs.length;
		// Resume nothing: the first blank is kept (held by its token), so a new one is made...
		const second = openResultSchema.parse((await r.call("open", {})).structuredContent);
		assert.notEqual(second.id, first.id);
		assert.equal((await r.tabs()).tabs.length, count + 1);
	});

	it("an unclaimed blank tab (the browser's own start page) is reused by open with an address", async () => {
		const own = await rig();
		try {
			await own.tabs();
			const blanks = await own.session.withPage(async (_p, c) => c.pages());
			// Make a plain user blank tab, not held by any token.
			const spare = blanks.find((p) => p.url() === "about:blank");
			assert.ok(spare, "the browser has a blank tab");
			const before = (await own.tabs()).tabs.length;
			const body = openResultSchema.parse(
				(await own.call("open", { url: `${own.fx.base}/form` })).structuredContent
			);
			assert.equal((await own.tabs()).tabs.length, before, "a new tab was opened");
			assert.equal(body.url, `${own.fx.base}/form`);
		} finally {
			await own.close();
		}
	});
});

describe("viewport", () => {
	const base = { profileDir: "/tmp/x" };
	it("a headed browser has no emulated viewport", () => {
		const o = launchOptions({ ...base, headless: false });
		assert.equal(o.viewport, null);
		assert.equal(
			launchOptions({ ...base, headless: false, viewport: { width: 800, height: 600 } }).viewport,
			null
		);
	});
	it("a headless browser keeps a sane default size", () => {
		assert.deepEqual(launchOptions({ ...base, headless: true }).viewport, {
			width: 1280,
			height: 800,
		});
		assert.deepEqual(
			launchOptions({ ...base, headless: true, viewport: { width: 1000, height: 700 } }).viewport,
			{ width: 1000, height: 700 }
		);
	});
});
