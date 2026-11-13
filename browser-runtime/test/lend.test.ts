import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

async function userTab(r: Rig, path: string) {
	const page = await r.session.withPage((_p, context) => context.newPage());
	await page.goto(r.fx.base + path);
	return page;
}

describe("a lent tab stays lent to the conversation", () => {
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
	type Kept = { token: string; lent?: boolean; origin?: string; url: string };

	it("end_task keep gives the lent tab a token, flagged lent with its site; the tab stays open", async () => {
		const { user } = await lend("/title?t=Lent&token=secret");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept?: Kept };
		assert.ok(end.kept && end.kept.token.length >= 20);
		assert.equal(end.kept.lent, true);
		assert.equal(end.kept.origin, r.fx.base);
		assert.ok(!end.kept.url.includes("?"), "a user's page is shown without its query");
		assert.equal(user.isClosed(), false);
		// The page the task opened itself is gone, the lent one is not.
		assert.equal((await r.tabs()).tabs.filter((t) => t.url.endsWith("/form")).length, 0);
		await user.close();
		await r.session.endTask();
	});

	it("resumes on the same site after a path and query change, with no approval, and keeps it lent", async () => {
		const { user } = await lend("/title?t=Step1");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		// The user moves on to the next step of the form: same origin, other path and query.
		await user.goto(`${r.fx.base}/list?step=2`);
		const back = (await r.call("resume", { token: end.kept.token })).structuredContent as {
			refused?: string;
			lent?: boolean;
			changed: boolean;
			url: string;
		};
		assert.equal(back.refused, undefined);
		assert.equal(back.lent, true);
		assert.equal(back.changed, false);
		assert.ok(back.url.endsWith("/list") || back.url.includes("/list"));
		const mine = (await r.tabs()).tabs.find((t) => t.url.includes("/list"))!;
		assert.equal(mine.mine, true);
		assert.equal((await r.snapshot()).url.includes("/list"), true);
		// The token was spent; the next end keeps the tab again, and nothing ever closes it.
		assert.equal((await r.call("resume", { token: end.kept.token })).isError, true);
		const again = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		assert.equal(again.kept.lent, true);
		assert.equal(user.isClosed(), false);
		await r.session.endTask();
		assert.equal(user.isClosed(), false);
		await user.close();
	});

	it("follows the tab when Cerea itself takes it to another site with an approval", async () => {
		const { user } = await lend("/title?t=Moved");
		const snap = await r.snapshot();
		const nav = { type: "navigate" as const, url: `${r.fx.other}/title?t=Elsewhere` };
		assert.equal((await r.act([nav])).results[0].refused, "approval_required");
		const moved = await r.act([nav], [r.grant(snap, nav)]);
		assert.equal(moved.results[0].ok, true, JSON.stringify(moved));
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept?: Kept };
		assert.equal(end.kept?.lent, true);
		assert.equal(end.kept?.origin, r.fx.other, "the lent origin followed the approved navigation");
		const back = (await r.call("resume", { token: end.kept!.token })).structuredContent as {
			refused?: string;
			lent?: boolean;
		};
		assert.equal(back.refused, undefined);
		assert.equal(back.lent, true);
		// The user then moves it themselves to a third site: not followed.
		const end2 = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		await user.goto(`${r.fx.base}/title?t=Third`);
		const refused = (await r.call("resume", { token: end2.kept.token })).structuredContent as {
			refused?: string;
		};
		assert.equal(refused.refused, "page_changed");
		await user.close();
	});

	it("refuses to resume once the tab is on another origin: it is a user tab again", async () => {
		const { user } = await lend("/title?t=Away");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		await user.goto(`${r.fx.other}/title?t=Bank`);
		const back = (await r.call("resume", { token: end.kept.token })).structuredContent as {
			refused?: string;
			url: string;
		};
		assert.equal(back.refused, "page_changed");
		assert.ok(!back.url.includes("?"));
		const tab = (await r.tabs()).tabs.find((t) => t.title === "Bank")!;
		assert.equal(tab.mine, false);
		assert.equal(
			(await r.act([{ type: "use_tab", tab: tab.id }])).results[0].refused,
			"approval_required"
		);
		assert.equal(user.isClosed(), false);
		await user.close();
	});

	it("a lent tab that was closed cannot be resumed", async () => {
		const { user } = await lend("/title?t=Gone");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		await user.close();
		assert.equal((await r.call("resume", { token: end.kept.token })).isError, true);
	});

	it("a tab that is not lent is not kept as lent: a page the task opened has no lent flag", async () => {
		await r.session.endTask();
		await r.goto("/form");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		assert.equal(end.kept.lent, undefined);
		assert.equal(end.kept.origin, undefined);
		await r.session.endTask();
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

describe("lent tab idle expiry", () => {
	it("its token lapses after lentTtlMs since the last use, and the tab stays open", async () => {
		const own = await rig({ lentTtlMs: 250 });
		try {
			await own.goto("/form");
			const user = await userTab(own, "/title?t=Idle");
			const tab = (await own.tabs()).tabs.find((t) => t.url.includes("/title"))!;
			await own.act([{ type: "use_tab", tab: tab.id }], [own.useTabGrant(tab)]);
			const { kept } = (await own.call("end_task", { keep: true })).structuredContent as {
				kept: { token: string };
			};
			await new Promise((ok) => setTimeout(ok, 500));
			assert.equal((await own.call("resume", { token: kept.token })).isError, true);
			assert.equal(user.isClosed(), false);
			// It is just a user's tab now.
			assert.equal((await own.tabs()).tabs.find((t) => t.id === tab.id)?.mine, false);
		} finally {
			await own.close();
		}
	});
});

describe("the lent origin is pinned and checked", () => {
	const lendAt = async (r: Rig, base: string, path: string) => {
		await r.goto("/form");
		const page = await r.session.withPage((_p, context) => context.newPage());
		await page.goto(base + path);
		const tab = (await r.tabs()).tabs.find((t) => t.url.includes("/title"))!;
		const res = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		return { page, tab };
	};
	type Kept = { token: string; lent?: boolean; origin?: string };
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("a same-site tab on another host is refused on resume (origin, not site)", async () => {
		const { page } = await lendAt(r, r.fx.other, "/title?t=A");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		assert.equal(end.kept.origin, r.fx.other);
		await page.goto(r.fx.other.replace("localhost", "sub.localhost") + "/title?t=B");
		const back = (await r.call("resume", { token: end.kept.token })).structuredContent as {
			refused?: string;
		};
		assert.equal(back.refused, "page_changed");
		await page.close();
	});

	it("a tab that left the origin it was lent on gets no token at end_task, even if it came back later", async () => {
		const { page } = await lendAt(r, r.fx.base, "/title?t=Pinned");
		await page.goto(`${r.fx.other}/title?t=Elsewhere`);
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept?: Kept };
		assert.equal(end.kept, undefined);
		assert.equal(page.isClosed(), false);
		await page.close();
	});

	it("a tab with no origin (about:blank) is never lent", async () => {
		await r.goto("/form");
		const page = await r.session.withPage((_p, context) => context.newPage());
		await r.session.endTask();
		const tab = (await r.tabs()).tabs.find((t) => t.id && t.url === "about:blank" && !t.mine);
		assert.ok(tab, "a blank user tab is listed");
		const res = await r.act([{ type: "use_tab", tab: tab.id }], [r.useTabGrant(tab)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept?: Kept };
		assert.equal(end.kept, undefined);
		await page.close().catch(() => undefined);
	});

	it("resume of a lent tab on a site the deny list now covers is refused and says nothing", async () => {
		const { page } = await lendAt(r, r.fx.base, "/title?t=Deny");
		const end = (await r.call("end_task", { keep: true })).structuredContent as { kept: Kept };
		await r.call("tabs", { deny: ["127.0.0.1"] });
		const back = (await r.call("resume", { token: end.kept.token })).structuredContent as {
			refused?: string;
			title: string;
			url: string;
		};
		assert.equal(back.refused, "page_changed");
		assert.equal(back.title, "");
		assert.equal(back.url, "");
		await r.call("tabs", { deny: [] });
		await page.close();
	});

	it("shows an adopted tab without query or fragment in tabs, and in the snapshot text", async () => {
		const { page } = await lendAt(r, r.fx.base, "/title?t=Quiet&token=secret#frag");
		const mine = (await r.tabs()).tabs.find((t) => t.mine && t.url.includes("/title"))!;
		assert.ok(!mine.url.includes("secret"));
		const snap = await r.snapshot();
		assert.ok(!snap.text.includes("secret"), snap.text);
		await r.session.endTask();
		await page.close();
	});
});

describe("the absolute lend cap", () => {
	it("a tab used for longer than lentMaxMs since the approval gets no token", async () => {
		const own = await rig({ lentMaxMs: 200 });
		try {
			await own.goto("/form");
			const user = await own.session.withPage((_p, c) => c.newPage());
			await user.goto(`${own.fx.base}/title?t=Cap`);
			const tab = (await own.tabs()).tabs.find((t) => t.url.includes("/title"))!;
			await own.act([{ type: "use_tab", tab: tab.id }], [own.useTabGrant(tab)]);
			await new Promise((ok) => setTimeout(ok, 400));
			const end = (await own.call("end_task", { keep: true })).structuredContent as {
				kept?: unknown;
			};
			assert.equal(end.kept, undefined);
			assert.equal(user.isClosed(), false);
		} finally {
			await own.close();
		}
	});
});
