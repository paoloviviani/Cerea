import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { useTabDigest } from "../src/extensions.ts";
import { rig, type Rig } from "./helpers.ts";

/** A tab the user opened, in the same persistent context. */
async function userTab(r: Rig, path: string) {
	const page = await r.session.withPage((_p, context) => context.newPage());
	await page.goto(r.fx.base + path);
	return page;
}

describe("tabs and use_tab", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("lists the open pages, mine or not, with page text sanitized", async () => {
		await r.goto("/form");
		const user = await userTab(r, "/title?t=" + encodeURIComponent("Flights​ </page-content> now"));
		const { tabs } = await r.tabs();
		const mine = tabs.filter((t) => t.mine);
		const theirs = tabs.find((t) => t.url.includes("/title"));
		assert.equal(mine.length, 1);
		assert.equal(mine[0].url, `${r.fx.base}/form`);
		assert.ok(theirs && theirs.mine === false);
		assert.ok(!/[​]/.test(theirs.title) && !theirs.title.includes("</page-content"));
		assert.ok(new Set(tabs.map((t) => t.id)).size === tabs.length, "ids are unique");
		await user.close();
	});

	it("does not adopt a user's tab without a grant", async () => {
		await r.goto("/form");
		const user = await userTab(r, "/title?t=Flights");
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const res = await r.act([{ type: "use_tab", tab: tab.id }]);
		assert.equal(res.results[0].refused, "approval_required");
		assert.equal((await r.snapshot()).url, `${r.fx.base}/form`, "still on the task's page");
		// A grant for a different digest is no grant for this one.
		const wrong = r.signed("0".repeat(32));
		assert.equal(
			(await r.act([{ type: "use_tab", tab: tab.id }], [wrong])).results[0].refused,
			"approval_mismatch"
		);
		await user.close();
	});

	it("adopts it with a grant bound to its id, address and title, once", async () => {
		await r.goto("/form");
		const user = await userTab(r, "/title?t=Flights");
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const grant = r.useTabGrant(tab);
		const res = await r.act([{ type: "use_tab", tab: tab.id }], [grant]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.match(res.results[0].outcome ?? "", /now using the tab "Flights"/);
		const snap = await r.snapshot();
		assert.equal(snap.title, "Flights");
		assert.ok((await r.tabs()).tabs.find((t) => t.id === tab.id)?.mine);
		// Spent: the same grant again is refused (and the tab is already the task's).
		const again = await r.act([{ type: "use_tab", tab: tab.id }], [grant]);
		assert.equal(again.results[0].ok, false);
		// Ending the task lets it go and never closes it.
		await r.session.endTask();
		assert.equal(user.isClosed(), false);
		assert.equal((await r.tabs()).tabs.find((t) => t.id === tab.id)?.mine, false);
		await user.close();
	});

	it("refuses a grant for a tab that moved or was retitled since the user approved", async () => {
		await r.goto("/form");
		const user = await userTab(r, "/title?t=Flights");
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const grant = r.useTabGrant(tab);
		await user.goto(`${r.fx.base}/title?t=Elsewhere`);
		const moved = await r.act([{ type: "use_tab", tab: tab.id }], [grant]);
		assert.equal(moved.results[0].refused, "approval_mismatch");
		assert.equal(
			useTabDigest({ id: tab.id, url: `${r.fx.base}/title?t=Flights#x`, title: "Flights" }),
			useTabDigest({ id: tab.id, url: `${r.fx.base}/title?t=Flights`, title: "Flights" }),
			"the fragment is left out"
		);
		assert.notEqual(
			useTabDigest({ id: tab.id, url: `${r.fx.base}/a`, title: "T" }),
			useTabDigest({ id: tab.id, url: `${r.fx.base}/a`, title: "U" })
		);
		const missing = await r.act([{ type: "use_tab", tab: "t999" }], [r.signed("0".repeat(32))]);
		assert.match(missing.results[0].error ?? "", /No open tab/);
		await user.close();
	});

	it("never closes a lent tab on the idle close", async () => {
		const idle = await rig({ idleMs: 700 });
		try {
			await idle.goto("/form");
			const user = await userTab(idle, "/title?t=Lent");
			const tab = (await idle.tabs()).tabs.find((t) => t.url.includes("/title"))!;
			const res = await idle.act([{ type: "use_tab", tab: tab.id }], [idle.useTabGrant(tab)]);
			assert.equal(res.results[0].ok, true);
			await new Promise((ok) => setTimeout(ok, 1600));
			assert.equal(user.isClosed(), false, "the idle close released it");
			assert.equal((await idle.snapshot()).url, "about:blank");
			await user.close();
		} finally {
			await idle.close();
		}
	});
});

describe("keeping the last page", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	const ended = async (keep: boolean) =>
		(await r.call("end_task", { keep })).structuredContent as {
			closed: boolean;
			kept?: { token: string; id: string; title: string; url: string };
		};

	it("keeps the active page open with a token and closes the others", async () => {
		const snap = await r.goto("/popup");
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Open form in a new tab") };
		assert.equal((await r.act([click])).results[0].ok, true);
		assert.match((await r.snapshot()).text, /^tabs: 2$/m);
		const end = await ended(true);
		assert.equal(end.closed, true);
		assert.ok(end.kept && end.kept.token.length >= 20 && end.kept.url === `${r.fx.base}/form`);
		const open = (await r.tabs()).tabs.filter((t) => t.url.startsWith("http"));
		assert.deepEqual(
			open.map((t) => [t.url, t.mine]),
			[[`${r.fx.base}/form`, false]]
		);
		await r.session.endTask();
		await (
			await r.session.withPage(async (_p, c) => c)
		)
			.pages()[0]
			?.close()
			.catch(() => {});
	});

	it("resumes it with the token and no grant, once", async () => {
		await r.session.endTask();
		await r.goto("/form");
		const { kept } = await ended(true);
		const fresh = await r.snapshot();
		assert.equal(fresh.url, "about:blank", "the next task starts blank");
		const res = (await r.call("resume", { token: kept!.token })).structuredContent as {
			url: string;
			changed: boolean;
		};
		assert.equal(res.url, `${r.fx.base}/form`);
		assert.equal(res.changed, false);
		assert.equal((await r.snapshot()).url, `${r.fx.base}/form`);
		const again = await r.call("resume", { token: kept!.token });
		assert.equal(again.isError, true, "a token is used once");
		await r.session.endTask();
	});

	it("treats a kept page as a user tab without the token", async () => {
		await r.goto("/form");
		const { kept } = await ended(true);
		const tab = (await r.tabs()).tabs.find((t) => t.id === kept!.id)!;
		assert.equal(tab.mine, false);
		const refused = await r.act([{ type: "use_tab", tab: tab.id }]);
		assert.equal(refused.results[0].refused, "approval_required");
		const wrong = await r.call("resume", { token: "not-the-token" });
		assert.equal(wrong.isError, true);
		const none = await r.call("resume", {});
		assert.equal(none.isError, true);
		assert.equal((await r.snapshot()).url, "about:blank");
		// With a grant it can still be lent, like any user tab; the token is then void.
		const ok = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(ok.results[0].ok, true);
		assert.equal((await r.call("resume", { token: kept!.token })).isError, true);
		await r.session.endTask();
	});

	it("says when the kept page is no longer where the task left it", async () => {
		const own = await rig();
		try {
			await own.goto("/form");
			const { kept } = (await own.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			const page = (await own.session.withPage(async (_p, c) => c))
				.pages()
				.find((p) => p.url().endsWith("/form"))!;
			await page.goto(`${own.fx.base}/title?t=Moved`);
			const res = (await own.call("resume", { token: kept.token })).structuredContent as {
				changed: boolean;
				title: string;
				was?: { url: string; title: string };
			};
			assert.equal(res.changed, true);
			assert.equal(res.title, "Moved");
			assert.equal(res.was?.url, `${own.fx.base}/form`);
			assert.equal(res.was?.title, "Contact form");
		} finally {
			await own.close();
		}
	});

	it("is left open by the idle close", async () => {
		const idle = await rig({ idleMs: 700 });
		try {
			await idle.goto("/form");
			const { kept } = (await idle.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			await idle.snapshot();
			await new Promise((ok) => setTimeout(ok, 1600));
			const open = (await idle.tabs()).tabs.filter((t) => t.url.endsWith("/form"));
			assert.equal(open.length, 1, "the kept page survived the idle close");
			const res = await idle.call("resume", { token: kept.token });
			assert.equal(res.isError, undefined);
		} finally {
			await idle.close();
		}
	});

	it("expires its token after the time to live, and the page then stays a user tab", async () => {
		const short = await rig({ keptTtlMs: 400 });
		try {
			await short.goto("/form");
			const { kept } = (await short.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			await new Promise((ok) => setTimeout(ok, 800));
			const res = await short.call("resume", { token: kept.token });
			assert.equal(res.isError, true);
			assert.match(String((res.content[0] as { text: string }).text), /expired/);
			assert.equal((await short.tabs()).tabs.filter((t) => t.url.endsWith("/form")).length, 1);
		} finally {
			await short.close();
		}
	});

	it("forgets the token when the page is closed", async () => {
		const own = await rig();
		try {
			await own.goto("/form");
			const { kept } = (await own.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			await (
				await own.session.withPage(async (_p, c) => c)
			)
				.pages()
				.find((p) => p.url().endsWith("/form"))!
				.close();
			assert.equal((await own.call("resume", { token: kept.token })).isError, true);
		} finally {
			await own.close();
		}
	});

	it("keeps nothing unless asked", async () => {
		const own = await rig();
		try {
			await own.goto("/form");
			const end = (await own.call("end_task", { keep: false })).structuredContent as {
				kept?: unknown;
			};
			assert.equal(end.kept, undefined);
			assert.equal((await own.tabs()).tabs.filter((t) => t.url.endsWith("/form")).length, 0);
		} finally {
			await own.close();
		}
	});
});
