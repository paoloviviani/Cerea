import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("task pages, dialogs, popups and hangs", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("starts a task on a fresh blank page, never on a page left on a site", async () => {
		const stray = await r.session.withPage(async (_p, context) => {
			const page = await context.newPage();
			await page.goto(`${r.fx.base}/form`);
			return page;
		});
		const snap = await r.snapshot();
		assert.equal(snap.url, "about:blank");
		assert.equal(stray.url(), `${r.fx.base}/form`, "a page the runtime did not open is left alone");
		await stray.close();
	});

	it("ends a task by closing its pages, and the next call opens a blank one", async () => {
		await r.goto("/form");
		const ended = await r.call("end_task");
		assert.equal(ended.isError, undefined);
		assert.deepEqual(ended.structuredContent, { closed: true });
		assert.equal((await r.snapshot()).url, "about:blank");
		// The profile outlives the task: the cookie is still there.
		const closed = await r.session.endTask();
		assert.equal(closed.closed, 1);
	});

	it("closes task pages after an idle period", async () => {
		const idle = await rig();
		(idle.session as unknown as { options: { idleMs: number } }).options.idleMs = 1500;
		try {
			await idle.goto("/form");
			await new Promise((ok) => setTimeout(ok, 2500));
			assert.equal((await idle.snapshot()).url, "about:blank");
		} finally {
			await idle.close();
		}
	});

	it("dismisses confirm and alert dialogs and says so in the result", async () => {
		const snap = await r.goto("/dialogs");
		const ask = await r.act([{ type: "click", ref: r.ref(snap, "button", "Ask") }]);
		assert.equal(ask.results[0].ok, true);
		assert.match(ask.results[0].outcome ?? "", /confirm dialog was dismissed: Really\?/);
		assert.equal(ask.title, "no", "confirm was answered with dismiss");
		const warn = await r.act([{ type: "click", ref: r.ref(snap, "button", "Warn") }]);
		assert.match(warn.results[0].outcome ?? "", /alert dialog was dismissed: Heads up/);
	});

	it("refuses file choosers as an action error", async () => {
		const snap = await r.goto("/dialogs");
		const res = await r.act([{ type: "click", ref: r.ref(snap, "button", "Choose file") }]);
		assert.equal(res.results[0].ok, false);
		assert.match(res.results[0].error ?? "", /File choosers are not supported/);
	});

	it("returns from an action that hangs the page", async () => {
		const snap = await r.goto("/dialogs");
		const started = Date.now();
		const res = await r.act([{ type: "click", ref: r.ref(snap, "button", "Hang") }]);
		assert.equal(res.results[0].ok, false);
		assert.ok(Date.now() - started < 45_000);
		assert.match(res.results[0].error ?? "", /stopped responding and was closed/);
		// The next call starts on a fresh page: the stuck one is gone.
		assert.equal((await r.snapshot()).url, "about:blank");
	});

	it("follows a popup as a task page and reports it", async () => {
		await r.session.endTask();
		const snap = await r.goto("/popup");
		const res = await r.act([
			{ type: "click", ref: r.ref(snap, "link", "Open form in a new tab") },
		]);
		assert.equal(res.results[0].ok, true);
		assert.match(res.results[0].outcome ?? "", /opened a new tab/);
		assert.equal(res.url, `${r.fx.base}/form`);
		const now = await r.snapshot();
		assert.match(now.text, /^tabs: 2$/m);
		await r.session.endTask();
		const after = await r.session.withPage(
			async (_p, c) => c.pages().filter((p) => p.url().startsWith("http")).length
		);
		assert.equal(after, 0, "popup closed with the task");
	});
});
