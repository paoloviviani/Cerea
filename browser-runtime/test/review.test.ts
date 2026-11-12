import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { UsedGrants } from "../src/grants.ts";
import { createToolHandler } from "../src/server.ts";
import { BrowserSession } from "../src/session.ts";
import { rig, type Rig } from "./helpers.ts";

type FetchMeta = (page: unknown, refs: string[]) => Promise<unknown>;

describe("unknown facts fail closed", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("marks an element whose facts could not be read, and treats its click as a commit", async () => {
		const self = r.session as unknown as { fetchMeta: FetchMeta };
		const real = self.fetchMeta;
		// What a busy main thread does: every DOM read in the page times out.
		self.fetchMeta = async (_page, refs) => ({ meta: new Map(), failed: new Set(refs) });
		try {
			const snap = await r.goto("/buttons");
			const plain = r.element(snap, r.ref(snap, "button", "Plain action"));
			assert.equal(plain.metaUnknown, true);
			const click = { type: "click" as const, ref: plain.ref };
			const refused = await r.act([click]);
			assert.equal(refused.results[0].refused, "approval_required");
			// A grant for exactly that action (as Cerea, which sees metaUnknown too, would issue) runs it.
			const ok = await r.act([click], [r.grant(snap, click)]);
			assert.equal(ok.results[0].ok, true, JSON.stringify(ok));
		} finally {
			self.fetchMeta = real;
		}
		const snap = await r.goto("/buttons");
		assert.equal(r.element(snap, r.ref(snap, "button", "Plain action")).metaUnknown, undefined);
	});
});

describe("an approval is spent before its action runs", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("a failed attempt cannot be retried", async () => {
		const snap = await r.goto("/disabled");
		const click = { type: "click" as const, ref: r.ref(snap, "button", "Send") };
		const grant = r.grant(snap, click, 0, "once-only");
		const first = await r.act([click], [grant]);
		assert.equal(first.results[0].ok, false);
		assert.equal(
			first.results[0].refused,
			undefined,
			"it passed the gate and failed while running"
		);
		const second = await r.act([click], [grant]);
		assert.equal(second.results[0].refused, "approval_mismatch");
		assert.match(second.results[0].error ?? "", /already used/);
	});
});

describe("approvals are spent once, for good", () => {
	let r: Rig;
	before(async () => {
		r = await rig({ actionBudgetMs: 800 });
	});
	after(() => r.close());

	it("shares one queue and one memory across connections", async () => {
		const snap = await r.goto("/form");
		const save = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		const grant = r.grant(snap, save, 0, "raced");
		// Two handlers are two HTTP requests, each with its own server.
		const a = createToolHandler(r.session);
		const b = createToolHandler(r.session);
		const posts = r.fx.hits.posts.length;
		const args = { actions: [save], approvals: [grant] };
		const [x, y] = await Promise.all([a("act", args), b("act", args)]);
		const ran = [x, y].filter(
			(res) => JSON.parse((res.content[0] as { text: string }).text).results[0].ok
		);
		assert.equal(ran.length, 1, "exactly one of two racing calls ran");
		assert.equal(r.fx.hits.posts.length, posts + 1);
	});

	it("remembers spent approvals across a restart", async () => {
		const snap = await r.goto("/form");
		const save = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		const grant = r.grant(snap, save, 0, "before-restart");
		assert.equal((await r.act([save], [grant])).results[0].ok, true);
		await r.session.close();
		const again = new BrowserSession({
			profileDir: r.profile,
			stateDir: r.stateDir,
			headless: true,
			noSandbox: process.env.CEREA_TEST_NO_SANDBOX === "1",
			keyFile: r.keyFile,
		});
		try {
			const page = await again.withPage(async (p) => p);
			await page.goto(`${r.fx.base}/form`);
			const handler = createToolHandler(again);
			const fresh = (await handler("snapshot", {})).structuredContent as {
				elements: Array<{ ref: string; name: string }>;
			};
			const ref = fresh.elements.find((e) => e.name === "Save")!.ref;
			const res = await handler("act", {
				actions: [{ type: "click", ref }],
				approvals: [{ ...grant }],
			});
			const out = JSON.parse((res.content[0] as { text: string }).text);
			// The digest no longer matches (new ref), but the id was spent: both refuse. Check the id path
			// directly through the store the restart loaded.
			assert.ok(out.results[0].refused);
			assert.ok(new UsedGrants(join(r.stateDir, "used-grants.json")).has("before-restart"));
		} finally {
			await again.close();
		}
	});

	it("keeps spent ids until they expire, however many there are", () => {
		const dir = join(tmpdir(), `used-${Math.random().toString(36).slice(2)}`);
		const file = join(dir, "u.json");
		const used = new UsedGrants(file);
		const now = Date.now();
		for (let i = 0; i < 1500; i += 1) used.add(`id-${i}`, now + 60_000, now);
		used.add("old", now - 1, now - 100_000);
		assert.ok(used.has("id-0", now) && used.has("id-1499", now));
		assert.ok(!used.has("old", now));
		const reloaded = new UsedGrants(file, now);
		assert.ok(reloaded.has("id-0", now) && reloaded.has("id-1499", now));
		assert.ok(!new UsedGrants(file, now + 120_000).has("id-0", now + 120_000), "gone after expiry");
		return rm(dir, { recursive: true, force: true });
	});

	it("closes a page whose action outlived its budget, so nothing finishes later", async () => {
		await r.goto("/form");
		const res = await r.act([{ type: "wait_for", ms: 20_000 }]);
		assert.equal(res.results[0].ok, false);
		assert.match(res.results[0].error ?? "", /did not finish in time.*page was closed/);
		assert.equal((await r.snapshot()).url, "about:blank", "the next call starts on a fresh page");
	});

	it("refuses a grant whose expiry is far beyond this clock", async () => {
		const snap = await r.goto("/form");
		const save = { type: "click" as const, ref: r.ref(snap, "button", "Save") };
		const far = r.grant(snap, save, 0, undefined, { exp: Date.now() + 16 * 60_000 });
		const res = await r.act([save], [far]);
		assert.equal(res.results[0].refused, "approval_mismatch");
		assert.match(res.results[0].error ?? "", /clocks/);
		const near = r.grant(snap, save, 0, undefined, { exp: Date.now() + 14 * 60_000 });
		assert.equal((await r.act([save], [near])).results[0].ok, true);
	});
});

describe("downloads: size, cause and crowding", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	const approved = async (name: string) => {
		const snap = await r.goto("/downloads2");
		const click = { type: "click" as const, ref: r.ref(snap, "link", name) };
		return r.act([click], [r.grant(snap, click)]);
	};

	it("turns away a file whose announced size is over the cap before fetching it", async () => {
		const res = await approved("Announced huge");
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		const got = await r.download();
		assert.equal(got.files[0].name, "big.bin");
		assert.match(got.files[0].skipped ?? "", /larger than 25 MB/);
		assert.equal(got.files[0].base64, undefined);
		assert.equal(got.files[0].actionIndex, 0);
	});

	it("stops a stream that has no announced size at the cap", async () => {
		const res = await approved("Streamed huge");
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		const got = await r.download();
		assert.equal(got.files[0].name, "stream.bin");
		assert.match(got.files[0].skipped ?? "", /larger than 25 MB/);
		assert.equal(got.files[0].base64, undefined);
		// Chromium's own transfer may run on into its temporary copy (Playwright deletes it);
		// what matters is that nothing past the cap was kept or handed on.
		assert.equal((await r.download()).files.length, 0);
	});

	it("gives a file to the first download only, and only from the link's own address", async () => {
		const two = await approved("Two files");
		assert.equal(two.downloads?.length, 1);
		assert.equal(two.downloads?.[0].name, "report.csv");
		const sneaky = await approved("Sneaky file");
		assert.equal(sneaky.downloads, undefined, "a script's blob is not the link's file");
		await new Promise((ok) => setTimeout(ok, 400));
		const held = JSON.parse(
			((await r.call("download", { all: true })).content[0] as { text: string }).text
		).files as Array<{ name: string; actionIndex?: number }>;
		const byName = Object.fromEntries(held.map((f) => [f.name, f.actionIndex]));
		assert.equal(byName["report.csv"], 0);
		assert.ok("second.csv" in byName && byName["second.csv"] === undefined);
		assert.ok("sneaky.csv" in byName && byName["sneaky.csv"] === undefined);
	});

	it("keeps a page's own downloads from crowding out an approved one", async () => {
		await r.call("download", { all: true });
		const snap = await r.goto("/downloads2");
		const spam = await r.act([{ type: "click", ref: r.ref(snap, "button", "Spam") }]);
		assert.equal(spam.results[0].ok, true);
		await new Promise((ok) => setTimeout(ok, 1200));
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Two files") };
		const res = await r.act([click], [r.grant(snap, click)]);
		assert.equal(res.downloads?.[0].name, "report.csv");
		const held = JSON.parse(
			((await r.call("download", { all: true })).content[0] as { text: string }).text
		).files as Array<{ name: string; actionIndex?: number }>;
		assert.ok(held.filter((f) => f.actionIndex === undefined).length <= 5);
		assert.ok(held.some((f) => f.name === "report.csv" && f.actionIndex === 0));
	});
});

describe("popups and tabs", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("never adopts a tab the user opened, even while an action runs", async () => {
		const snap = await r.goto("/form");
		const user = await r.session.withPage((_p, context) => context.newPage());
		await user.goto(`${r.fx.base}/list`);
		const res = await r.act([{ type: "click", ref: r.ref(snap, "textbox", "Full name") }]);
		assert.equal(res.url, `${r.fx.base}/form`);
		assert.equal((await r.snapshot()).url, `${r.fx.base}/form`);
		assert.match((await r.snapshot()).text, /^url: .*\/form$/m);
		assert.ok(!/^tabs:/m.test((await r.snapshot()).text), "the user's tab is not a task tab");
		await r.session.endTask();
		assert.equal(user.isClosed(), false, "and it is not closed with the task");
		await user.close();
	});

	it("reports a popup on another site and does not switch to it", async () => {
		const snap = await r.goto("/popup2");
		const click = { type: "click" as const, ref: r.ref(snap, "link", "Partner in a new tab") };
		const res = await r.act([click], [r.grant(snap, click)]);
		assert.equal(res.results[0].ok, true, JSON.stringify(res));
		assert.match(
			res.results[0].outcome ?? "",
			/a new tab opened on localhost; it was not switched to/
		);
		assert.equal(res.url, `${r.fx.base}/popup2`);
	});
});

describe("housekeeping", () => {
	it("tightens a loose profile directory to 0700 when the browser starts", async () => {
		const r = await rig();
		try {
			await mkdir(r.profile, { recursive: true });
			const { chmod } = await import("node:fs/promises");
			await chmod(r.profile, 0o755);
			await r.snapshot();
			assert.equal((await stat(r.profile)).mode & 0o777, 0o700);
		} finally {
			await r.close();
		}
	});

	it("removes the download folders of runtimes that died, and leaves living ones", async () => {
		const dead = spawnSync(process.execPath, ["-e", "0"]);
		assert.equal(dead.status, 0);
		// A pid that is certainly gone: a finished child's.
		const gone = join(tmpdir(), `cerea-browser-${dead.pid}-stale`);
		const mine = join(tmpdir(), `cerea-browser-${process.pid}-mine`);
		for (const d of [gone, mine]) {
			await mkdir(d, { recursive: true });
			await writeFile(join(d, "f"), "x");
		}
		const r = await rig();
		try {
			await r.snapshot();
			await assert.rejects(stat(gone));
			await stat(mine);
		} finally {
			await r.close();
			await rm(mine, { recursive: true, force: true });
		}
		void mkdtemp;
	});
});

describe("a blank page is no stepping stone (mirrors Cerea's task context)", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("lets the task's first move leave its blank start page, then judges blank pages by the last site", async () => {
		await r.call("end_task", {});
		// A fresh task page starts at about:blank: its first navigation needs no approval.
		const first = await r.act([{ type: "navigate", url: r.fx.base + "/buttons" }]);
		assert.equal(first.results[0].ok, true, JSON.stringify(first));
		// Mid-task, going to a blank page is refused without an approval.
		const blank = await r.act([{ type: "navigate", url: "about:blank" }]);
		assert.equal(blank.results[0].ok, false);
		assert.ok(blank.results[0].refused, JSON.stringify(blank));
		// And from the site, another site still needs an approval.
		const away = await r.act([{ type: "navigate", url: r.fx.other + "/buttons" }]);
		assert.equal(away.results[0].refused, "approval_required", JSON.stringify(away));
	});
});
