import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

async function userTab(r: Rig, path: string) {
	const page = await r.session.withPage((_p, context) => context.newPage());
	await page.goto(r.fx.base + path);
	return page;
}

describe("a lent tab is never kept, closed or resumed after it moved", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	const lend = async (path: string) => {
		await r.goto("/form");
		const user = await userTab(r, path);
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const res = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		return { user, tab };
	};

	it("end_task keep does not keep an adopted tab: it is released and left open", async () => {
		const { user } = await lend("/title?t=Lent");
		const end = (await r.call("end_task", { keep: true })).structuredContent as {
			closed: boolean;
			kept?: unknown;
		};
		assert.equal(end.kept, undefined, "a user's tab gets no token");
		assert.equal(user.isClosed(), false);
		await user.close();
	});

	it("keeps a page the task opened, but not one adopted after it", async () => {
		await r.session.endTask();
		await r.goto("/form");
		const user = await userTab(r, "/title?t=Second");
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		// The adopted tab is active; the task's own /form page is closed, the lent one is released.
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept?: unknown };
		assert.equal(end.kept, undefined);
		assert.equal(user.isClosed(), false);
		assert.equal((await r.tabs()).tabs.filter((t) => t.url.endsWith("/form")).length, 0);
		await user.close();
	});

	it("keeps the adopted flag through every release: a hung-page drop, the end, the idle close", async () => {
		const { user, tab } = await lend("/title?t=Lent2");
		// The path that drops a page that stopped answering.
		(r.session as unknown as { taintPage(p: unknown): void }).taintPage(user);
		await new Promise((ok) => setTimeout(ok, 400));
		assert.equal(user.isClosed(), false, "a hung-page drop closed a user's tab");
		assert.equal((await r.tabs()).tabs.find((t) => t.id === tab.id)?.mine, false);
		// Lent again, then ended.
		const again = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(again.results[0].ok, true);
		await r.session.endTask();
		assert.equal(user.isClosed(), false);
		await user.close();
	});

	it("refuses to resume a page that was moved since it was kept", async () => {
		const own = await rig();
		try {
			await own.goto("/form");
			const { kept } = (await own.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			const page = (await own.session.withPage(async (_p, c) => c))
				.pages()
				.find((p) => p.url().endsWith("/form"))!;
			await page.goto(`${own.fx.base}/title?t=Bank`);
			const res = await own.call("resume", { token: kept.token });
			assert.equal(res.isError, undefined);
			const body = res.structuredContent as { refused?: string; title: string; url: string };
			assert.equal(body.refused, "page_changed");
			assert.equal(body.title, "Bank");
			assert.ok(!body.url.includes("?"), "the user's page is shown without its query");
			assert.equal((await own.snapshot()).url, "about:blank", "the task did not take the page");
			assert.equal(page.isClosed(), false);
			// The token is spent; the page is a user tab that needs use_tab.
			assert.equal((await own.call("resume", { token: kept.token })).isError, true);
			const tab = (await own.tabs()).tabs.find((t) => t.title === "Bank")!;
			assert.equal(tab.mine, false);
			assert.equal(
				(await own.act([{ type: "use_tab", tab: tab.id }])).results[0].refused,
				"approval_required"
			);
		} finally {
			await own.close();
		}
	});

	it("refuses a changed query or path, and ignores a fragment", async () => {
		for (const [change, ok] of [
			["/form?x=1", false],
			["/list", false],
			["/form#section", true],
		] as const) {
			const own = await rig();
			try {
				await own.goto("/form");
				const { kept } = (await own.call("end_task", { keep: true })).structuredContent as {
					kept: { token: string };
				};
				const page = (await own.session.withPage(async (_p, c) => c))
					.pages()
					.find((p) => p.url().endsWith("/form"))!;
				await page.goto(own.fx.base + change);
				const body = (await own.call("resume", { token: kept.token })).structuredContent as {
					refused?: string;
				};
				assert.equal(body.refused === undefined, ok, change);
			} finally {
				await own.close();
			}
		}
	});
});

describe("tabs() hygiene", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("shows a user's tab without query or fragment, and the task's own page in full", async () => {
		await r.goto("/form?session=secret#frag");
		const user = await userTab(r, "/title?t=Flights&token=abc#seat");
		const { tabs } = await r.tabs();
		const theirs = tabs.find((t) => !t.mine && t.url.includes("/title"))!;
		assert.equal(theirs.url, `${r.fx.base}/title`);
		const mine = tabs.find((t) => t.mine)!;
		assert.equal(mine.url, `${r.fx.base}/form?session=secret#frag`);
		// A grant for the tab as shown (no query) is the one that matches.
		const res = await r.act([{ type: "use_tab", tab: theirs.id }], [r.useTabGrant(theirs)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		await r.session.endTask();
		await user.close();
	});

	it("hides tabs on a denied site, and refuses to use one", async () => {
		await r.goto("/form");
		const user = await userTab(r, "/title?t=Bank");
		const shown = (await r.call("tabs", { deny: ["127.0.0.1"] })).structuredContent as {
			tabs: Array<{ id: string; title: string; url: string; mine: boolean }>;
		};
		const hidden = shown.tabs.find((t) => !t.mine && t.title === "a page on a denied site");
		assert.ok(hidden && hidden.url === "");
		assert.ok(!shown.tabs.some((t) => t.title === "Bank"));
		assert.ok(
			shown.tabs.some((t) => t.mine && t.url.includes("/form")),
			"the task's own page stays"
		);
		const res = await r.act(
			[{ type: "use_tab", tab: hidden.id }],
			[r.useTabGrant({ id: hidden.id, url: "", title: "a page on a denied site" })]
		);
		assert.equal(res.results[0].ok, false);
		assert.match(res.results[0].error ?? "", /keep the agent out/);
		// A later list without the rule shows it again.
		assert.ok((await r.call("tabs", { deny: [] })).structuredContent);
		const open = (await r.tabs()).tabs.find((t) => t.title === "Bank");
		assert.ok(open, "an empty deny list unhides");
		await user.close();
	});
});

describe("keys while focus is in a verification widget", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("refuses a ref-less press when focus is inside the widget, and allows it elsewhere", async () => {
		await r.goto("/challenge?kind=recaptcha");
		const page = await r.session.withPage(async (p) => p);
		await page.evaluate(() => document.querySelector<HTMLElement>(".g-recaptcha button")!.focus());
		const refused = await r.act([{ type: "press", key: "Tab" }]);
		assert.equal(refused.results[0].refused, "challenge");
		assert.match(refused.results[0].error ?? "", /keys are not sent there/);
		await page.evaluate(() => (document.activeElement as HTMLElement).blur());
		const fine = await r.act([{ type: "press", key: "Tab" }]);
		assert.equal(fine.results[0].ok, true, JSON.stringify(fine));
	});

	it("refuses it when focus is on a reCAPTCHA frame", async () => {
		await r.session.withPage(async (page) => {
			await page.route("https://www.google.com/**", (route) =>
				route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" })
			);
		});
		await r.goto("/challenge?kind=iframe");
		const page = await r.session.withPage(async (p) => p);
		await page.evaluate(() => document.querySelector<HTMLElement>("iframe")!.focus());
		assert.equal((await r.act([{ type: "press", key: "Space" }])).results[0].refused, "challenge");
	});
});
