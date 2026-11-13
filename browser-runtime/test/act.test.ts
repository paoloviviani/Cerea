import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rig, type Rig } from "./helpers.ts";

describe("act", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("runs a batch of input actions with per-action results", async () => {
		const snap = await r.goto("/form");
		const res = await r.act([
			{ type: "fill", ref: r.ref(snap, "textbox", "Full name"), text: "Ada" },
			{ type: "fill", ref: r.ref(snap, "textbox", "Email"), text: "ada@example.test" },
			{ type: "select", ref: r.ref(snap, "combobox", "Role"), value: "Engineer" },
			{ type: "click", ref: r.ref(snap, "checkbox", "Keep me posted") },
			{ type: "scroll", direction: "down" },
			{ type: "wait_for", text: "Contact form", ms: 2000 },
		]);
		assert.equal(res.results.length, 6);
		assert.ok(
			res.results.every((x) => x.ok),
			JSON.stringify(res.results)
		);
		assert.equal(res.results[0].outcome, "typed 3 characters");
		assert.equal(res.results[2].outcome, "chose Engineer");
		assert.equal(res.url, `${r.fx.base}/form`);
		assert.equal(res.title, "Contact form");
		const after = await r.snapshot();
		assert.match(after.text, /textbox "Full name" value="Ada"/);
		assert.match(after.text, /combobox "Role" value="Engineer"/);
		assert.match(after.text, /checkbox "Keep me posted" checked/);
	});

	it("stops at the first failure and reports what ran", async () => {
		const snap = await r.goto("/form");
		const res = await r.act([
			{ type: "fill", ref: r.ref(snap, "textbox", "Full name"), text: "Grace" },
			{ type: "click", ref: "e999" },
			{ type: "fill", ref: r.ref(snap, "textbox", "Email"), text: "never@example.test" },
		]);
		assert.equal(res.results.length, 2);
		assert.equal(res.results[0].ok, true);
		assert.equal(res.results[1].ok, false);
		assert.match(res.results[1].error ?? "", /No element with ref e999/);
		const after = await r.snapshot();
		assert.doesNotMatch(after.text, /never@example/);
	});

	it("refuses a form submit without an approval, and does not submit", async () => {
		const snap = await r.goto("/form");
		const save = r.ref(snap, "button", "Save");
		const posts = r.fx.hits.posts.length;
		const res = await r.act([{ type: "click", ref: save }]);
		assert.equal(res.results[0].ok, false);
		assert.equal(res.results[0].refused, "approval_required");
		assert.equal(r.fx.hits.posts.length, posts);
		assert.equal(res.url, `${r.fx.base}/form`);
	});

	it("accepts the submit with a grant for exactly that action", async () => {
		const snap = await r.goto("/form");
		await r.act([{ type: "fill", ref: r.ref(snap, "textbox", "Full name"), text: "Ada" }]);
		const after = await r.snapshot();
		const action = { type: "click" as const, ref: r.ref(after, "button", "Save") };
		const res = await r.act([action], [r.grant(after, action)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.equal(r.fx.hits.posts.at(-1)?.path, "/form");
		assert.equal(r.fx.hits.posts.at(-1)?.body.name, "Ada");
		assert.equal(res.title, "Done");
	});

	it("binds a grant to the exact action: another ref, another kind, a changed control", async () => {
		const snap = await r.goto("/form");
		const save = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		const grant = r.grant(snap, save);
		// The same grant on a different submit-capable action: a fill that presses Enter.
		const other = {
			type: "fill" as const,
			ref: r.ref(snap, "textbox", "Full name"),
			text: "x",
			submit: true,
		};
		const res1 = await r.act([other], [grant]);
		assert.equal(res1.results[0].refused, "approval_mismatch");
		// A grant at another index does not cover this one.
		const res2 = await r.act([save], [{ ...grant, index: 1 }]);
		assert.equal(res2.results[0].refused, "approval_required");
		// A digest for a different page (same click, other origin) does not match.
		const wrong = r.grant({ ...snap, url: "https://elsewhere.example/form" }, save);
		const res3 = await r.act([save], [wrong]);
		assert.equal(res3.results[0].refused, "approval_mismatch");
		// A grant issued for a control named differently ("Pay €120" then, "Save" now).
		const renamed = {
			...snap,
			elements: snap.elements.map((e) => (e.ref === save.ref ? { ...e, name: "Pay €120" } : e)),
		};
		const res4 = await r.act([save], [r.grant(renamed, save)]);
		assert.equal(res4.results[0].refused, "approval_mismatch");
		// A control that changes under the page gets a new ref: the old one names nothing, nothing runs.
		const page = await r.session.withPage(async (p) => p);
		await page.evaluate(() => {
			document.querySelector("button")!.textContent = "Pay now";
		});
		const res5 = await r.act([save], [grant]);
		assert.equal(res5.results[0].ok, false);
		assert.ok(!r.fx.hits.posts.some((p) => p.path === "/form" && p.body.name === "x"));
	});

	it("spends a user's approval once, but lets a site rule stand", async () => {
		const snap = await r.goto("/form");
		const action = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		const once = r.grant(snap, action, 0, "elicitation-1");
		assert.equal((await r.act([action], [once])).results[0].ok, true);
		const again = await r.goto("/form");
		const action2 = { type: "click" as const, ref: r.ref(again, "button", "Save") };
		const replay = await r.act([action2], [r.grant(again, action2, 0, "elicitation-1")]);
		assert.equal(replay.results[0].refused, "approval_mismatch");
		assert.match(replay.results[0].error ?? "", /already used/);
		const site = await r.goto("/form");
		const action3 = { type: "click" as const, ref: r.ref(site, "button", "Save") };
		const grant = r.grant(site, action3, 0, `site:127.0.0.1`);
		assert.equal((await r.act([action3], [grant])).results[0].ok, true);
		const site2 = await r.goto("/form");
		const action4 = { type: "click" as const, ref: r.ref(site2, "button", "Save") };
		assert.equal(
			(await r.act([action4], [r.grant(site2, action4, 0, `site:127.0.0.1`)])).results[0].ok,
			true
		);
	});

	it("does not need an approval for a GET search, a same-site link or plain input", async () => {
		const search = await r.goto("/search");
		await r.act([{ type: "fill", ref: r.ref(search, "searchbox", "Query"), text: "kiwi" }]);
		const res = await r.act([{ type: "click", ref: r.ref(search, "button", "Search") }]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.equal(res.url, `${r.fx.base}/search?q=kiwi`);
	});

	it("walks pagination by links", async () => {
		let snap = await r.goto("/list");
		for (const page of [2, 3]) {
			const res = await r.act([{ type: "click", ref: r.ref(snap, "link", "Next") }]);
			assert.equal(res.results[0].ok, true);
			snap = await r.snapshot();
			assert.match(snap.text, new RegExp(`Page ${page} of 5`));
		}
	});

	it("treats navigation inside the site as read and to another site as commit", async () => {
		await r.goto("/form");
		const same = await r.act([{ type: "navigate", url: "/list?page=4" }]);
		assert.equal(same.results[0].ok, true);
		assert.equal(same.url, `${r.fx.base}/list?page=4`);
		const away = await r.act([{ type: "navigate", url: `${r.fx.other}/form` }]);
		assert.equal(away.results[0].refused, "approval_required");
		assert.equal(away.url, `${r.fx.base}/list?page=4`);
		const snap = await r.snapshot();
		const nav = { type: "navigate" as const, url: `${r.fx.other}/form` };
		const ok = await r.act([nav], [r.grant(snap, nav)]);
		assert.equal(ok.results[0].ok, true, JSON.stringify(ok));
		assert.equal(ok.url, `${r.fx.other}/form`);
	});

	it("never opens a non-web address, even with an approval", async () => {
		const snap = await r.goto("/form");
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"chrome://settings",
			"data:text/html,hi",
		]) {
			const nav = { type: "navigate" as const, url };
			const res = await r.act([nav], [r.grant(snap, nav)]);
			assert.equal(res.results[0].ok, false, url);
			assert.match(res.results[0].error ?? "", /Only http and https/);
			assert.equal(res.url, snap.url);
		}
	});

	it("treats Enter or Space with no element named, and modified Enter, as commit", async () => {
		const snap = await r.goto("/form");
		await r.act([{ type: "click", ref: r.ref(snap, "textbox", "Full name") }]);
		const posts = r.fx.hits.posts.length;
		const res = await r.act([{ type: "press", key: "Enter" }]);
		assert.equal(res.results[0].refused, "approval_required");
		assert.match(res.results[0].error ?? "", /approval/);
		assert.equal(r.fx.hits.posts.length, posts);
	});

	it("lets select-all and the like through, asks for a paste, and reads Enter by what it would do", async () => {
		const snap = await r.goto("/meta");
		const first = r.ref(snap, "textbox", "First");
		const lone = r.ref(snap, "textbox", "Lone");
		const where = r.ref(snap, "textbox", "Where to");
		const editor = r.ref(snap, "textbox", "Message");
		const posts = r.fx.hits.posts.length;
		await r.act([{ type: "fill", ref: first, text: "x" }]);
		for (const key of ["Control+a", "Meta+c", "Control+z", "Control+Shift+Z"]) {
			assert.equal((await r.act([{ type: "press", key, ref: first }])).results[0].ok, true, key);
		}
		for (const key of ["Control+v", "Shift+Insert"]) {
			assert.equal(
				(await r.act([{ type: "press", key, ref: first }])).results[0].refused,
				"approval_required",
				key
			);
		}
		// A field of a form with no submit control only takes the key.
		assert.equal((await r.act([{ type: "press", key: "Enter", ref: first }])).results[0].ok, true);
		// A form's one text field submits on Enter, an editor sends, a search reads.
		assert.equal(
			(await r.act([{ type: "press", key: "Enter", ref: lone }])).results[0].refused,
			"approval_required"
		);
		assert.equal(
			(await r.act([{ type: "press", key: "Enter", ref: editor }])).results[0].refused,
			"approval_required"
		);
		assert.equal((await r.act([{ type: "press", key: "Enter", ref: where }])).results[0].ok, true);
		assert.equal(r.fx.hits.posts.length, posts);
	});

	it("walks a login wall: the sign-in needs an approval, then the page opens", async () => {
		const wall = await r.goto("/dashboard");
		assert.match(wall.text, /Please sign in first/);
		const login = await r.goto("/login");
		await r.act([
			{ type: "fill", ref: r.ref(login, "textbox", "Username"), text: "demo" },
			{ type: "fill", ref: r.ref(login, "textbox", "Password"), text: "s3cret-pass" },
		]);
		const form = await r.snapshot();
		const click = { type: "click" as const, ref: r.ref(form, "button", "Sign in") };
		assert.equal((await r.act([click])).results[0].refused, "approval_required");
		const res = await r.act([click], [r.grant(form, click)]);
		assert.equal(res.results[0].ok, true);
		assert.equal(res.url, `${r.fx.base}/dashboard`);
		assert.match((await r.snapshot()).text, /Welcome back, demo/);
	});

	it("keeps the login in the profile across a restart of the browser", async () => {
		await r.session.close();
		const snap = await r.goto("/dashboard");
		assert.match(snap.text, /Welcome back, demo/, "the cookie lives in the persistent profile");
	});
});
