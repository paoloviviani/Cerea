import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Frame } from "../src/live.ts";
import { parseInputEvents } from "../src/live.ts";
import { rig, type Rig } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 5_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await ok()) return;
		await sleep(25);
	}
	assert.fail(`timed out waiting for ${what}`);
};

const log = (r: Rig): Promise<string[]> =>
	r.session.withPage((page) => page.evaluate(() => (window as never as { __log: string[] }).__log));

describe("control: takeover pauses the agent", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
		await r.goto("/pad");
	});
	after(() => r.close());

	it("answers every agent tool with paused while the user is in control", async () => {
		const state = (await r.call("control", { action: "takeover" })).structuredContent;
		assert.deepEqual(
			{ ...state, since: undefined },
			{ controller: "user", source: "cerea", since: undefined }
		);
		for (const [tool, args] of [
			["snapshot", {}],
			["diff", {}],
			["act", { actions: [{ type: "scroll" }] }],
			["extract", {}],
			["screenshot", {}],
			["download", {}],
			["tabs", {}],
		] as const) {
			const res = await r.call(tool, args);
			assert.equal(res.isError, true, tool);
			assert.deepEqual(res.structuredContent, { paused: true }, tool);
		}
		// Control and the user's own tools still work.
		assert.equal(
			((await r.call("control", { action: "state" })).structuredContent as { controller: string })
				.controller,
			"user"
		);
	});

	it("resumes on hand back, and the agent reads the page again", async () => {
		await r.call("control", { action: "handback" });
		const snap = await r.snapshot();
		assert.match(snap.text, /Pad/);
		assert.equal(
			((await r.call("control", { action: "state" })).structuredContent as { controller: string })
				.controller,
			"agent"
		);
	});

	it("stops a running batch at the next action and says so", async () => {
		const run = r.act([
			{ type: "wait_for", ms: 400 },
			{ type: "wait_for", ms: 400 },
			{ type: "wait_for", ms: 400 },
		]);
		await sleep(150);
		await r.call("control", { action: "takeover" });
		const result = await run;
		assert.equal(result.paused, true);
		assert.ok(result.results.length < 3, `ran ${result.results.length} of 3`);
		await r.call("control", { action: "handback" });
	});

	it("end_task gives control back", async () => {
		await r.call("control", { action: "takeover" });
		await r.call("end_task", {});
		assert.equal(r.session.live.paused, false);
	});
});

describe("input: the user's own events", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
		await r.goto("/pad");
	});
	after(() => r.close());

	it("is refused unless the user is in control", async () => {
		const res = await r.call("input", { events: [{ type: "text", text: "x" }] });
		assert.equal(res.isError, true);
		assert.match(JSON.stringify(res.content), /takeover/);
	});

	it("clicks, types, presses special keys, scrolls and touches", async () => {
		await r.call("control", { action: "takeover" });
		const send = async (events: unknown[]) => {
			const res = await r.call("input", { events });
			assert.equal(res.isError, undefined, JSON.stringify(res.content));
			return res.structuredContent as { sent: number; dropped: number };
		};
		// The button, a real click: trusted, as if a person made it.
		await send([
			{ type: "mouse", action: "move", x: 150, y: 220 },
			{ type: "mouse", action: "down", x: 150, y: 220, button: "left" },
			{ type: "mouse", action: "up", x: 150, y: 220, button: "left" },
		]);
		await until("the click", async () => (await log(r)).includes("click:trusted"));
		// Typing: focus the field, then insert text (what a phone keyboard or an IME sends).
		await send([
			{ type: "mouse", action: "down", x: 200, y: 312 },
			{ type: "mouse", action: "up", x: 200, y: 312 },
			{ type: "text", text: "héllo wörld" },
		]);
		await until("the text", async () => (await log(r)).includes("input:héllo wörld"));
		// A special key.
		await send([
			{ type: "key", action: "down", key: "Backspace" },
			{ type: "key", action: "up", key: "Backspace" },
		]);
		await until("backspace", async () => (await log(r)).includes("input:héllo wörl"));
		// Touch, as a phone sends it.
		await send([
			{ type: "touch", action: "start", points: [{ x: 450, y: 250 }] },
			{ type: "touch", action: "end", points: [] },
		]);
		await until("the touch", async () => (await log(r)).includes("touchend"));
		// The wheel scrolls the page.
		await send([{ type: "mouse", action: "wheel", x: 600, y: 600, deltaY: 300 }]);
		await until("the scroll", async () => (await log(r)).includes("wheel"));
		await r.call("control", { action: "handback" });
	});

	it("rejects what is not an event", () => {
		assert.throws(() => parseInputEvents([]), /list of events/);
		assert.throws(
			() => parseInputEvents([{ type: "mouse", action: "move", x: NaN, y: 1 }]),
			/x and y/
		);
		assert.throws(
			() => parseInputEvents([{ type: "mouse", action: "move", x: 1e9, y: 1 }]),
			/x and y/
		);
		assert.throws(
			() => parseInputEvents([{ type: "key", action: "down", key: "a" }]),
			/special keys/
		);
		assert.throws(() => parseInputEvents([{ type: "eval", code: "1" }]), /type is/);
		assert.throws(
			() => parseInputEvents(Array.from({ length: 65 }, () => ({ type: "text", text: "a" }))),
			/at most 64/
		);
		assert.throws(() => parseInputEvents([{ type: "text", text: "a".repeat(4001) }]), /characters/);
	});
});

describe("screencast: frames on repaint, acked, stopped", () => {
	let r: Rig;
	const frames: Frame[] = [];
	before(async () => {
		r = await rig({ live: { maxInFlight: 2, minFrameMs: 20, viewerTimeoutMs: 700 } });
		await r.goto("/pad");
		r.session.live.setSink((f) => frames.push(f));
	});
	after(() => r.close());

	it("sends JPEG frames of the viewport, no more than the viewer has credit for", async () => {
		await r.call("screencast", { action: "start", width: 640 });
		await until("two frames", () => frames.length >= 2);
		await sleep(300);
		// Nobody acked: it holds at the credit and keeps only the newest.
		assert.equal(frames.length, 2);
		const first = frames[0]!;
		assert.equal(Buffer.from(first.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
		assert.equal(first.mime, "image/jpeg");
		assert.equal(first.width, 1280);
		assert.equal(first.height, 800);
		assert.equal(first.seq, 1);
		// An ack is credit: the next frame follows, and it is a newer one.
		await r.call("screencast", { action: "ack", seq: 2 });
		await until("a third frame", () => frames.length >= 3);
		assert.ok(frames[2]!.seq > 2);
	});

	it("stops when the viewer goes quiet, and on stop", async () => {
		await until("the viewer timeout", () => !r.session.live.casting, 3_000);
		const n = frames.length;
		await sleep(300);
		assert.equal(frames.length, n);
		await r.call("screencast", { action: "start", width: 400 });
		assert.equal(r.session.live.casting, true);
		await r.call("screencast", { action: "stop" });
		assert.equal(r.session.live.casting, false);
	});

	it("stops with the task", async () => {
		await r.call("screencast", { action: "start" });
		assert.equal(r.session.live.casting, true);
		await r.call("end_task", {});
		assert.equal(r.session.live.casting, false);
	});

	it("refuses to start without a sink (a runtime not on stdio)", async () => {
		r.session.live.setSink(undefined);
		const res = await r.call("screencast", { action: "start" });
		assert.equal(res.isError, true);
	});
});

describe("banner: in the window, not in the agent's view", () => {
	let r: Rig;
	before(async () => {
		r = await rig({ banner: true });
		await r.goto("/form");
		// The banner follows tool calls: any call after the page exists shows it.
		await r.snapshot();
	});
	after(() => r.close());

	const selector = () => r.session.live.bannerHostSelector()!;
	const present = () =>
		r.session.withPage((page) => page.evaluate((sel) => !!document.querySelector(sel), selector()));
	const buttonAt = () =>
		r.session.withPage((page) =>
			page.evaluate((sel) => {
				const rect = document.querySelector(sel)!.getBoundingClientRect();
				return { x: rect.right - 30, y: rect.top + rect.height / 2 };
			}, selector())
		);

	it("shows on the task page and is in neither the snapshot, the extract nor the screenshot", async () => {
		await until("the banner", present);
		const snap = await r.snapshot();
		assert.doesNotMatch(snap.text, /Cerea is using|Take over|Hand back/i);
		assert.ok(!snap.elements.some((e) => /take over/i.test(e.name ?? "")));
		const text = JSON.stringify((await r.extract({ mode: "text" })).text ?? "");
		assert.doesNotMatch(text, /Cerea is using|Take over/i);
		// The screenshot is the page without the bar: the same as one taken with the bar removed.
		const shot = (await r.call("screenshot", {})).content[0] as { data: string };
		const raw = await r.session.withPage((page) => page.screenshot({ type: "png" }));
		assert.notEqual(shot.data, raw.toString("base64"), "the bar is in a raw screenshot");
		await r.session.withPage((page) =>
			page.evaluate((sel) => document.querySelector(sel)!.remove(), selector())
		);
		const without = await r.session.withPage((page) => page.screenshot({ type: "png" }));
		assert.equal(shot.data, without.toString("base64"));
		// A tool call shows it again.
		await r.snapshot();
		await until("the banner again", present);
	});

	it("a click on it takes control; a second hands back", async () => {
		const at = await buttonAt();
		await r.session.withPage((page) => page.mouse.click(at.x, at.y));
		await until("takeover", () => r.session.live.paused);
		assert.equal(r.session.live.control().source, "banner");
		assert.equal((await r.call("snapshot", {})).isError, true);
		const again = await buttonAt();
		await r.session.withPage((page) => page.mouse.click(again.x, again.y));
		await until("hand back", () => !r.session.live.paused);
		assert.match((await r.snapshot()).text, /Contact form/);
	});

	it("a page script cannot reach it, click it or call its binding", async () => {
		await r.snapshot();
		await until("the banner", present);
		const outcome = await r.session.withPage((page) =>
			page.evaluate((sel) => {
				const host = document.querySelector(sel)!;
				const seen = {
					shadow: host.shadowRoot,
					globals: Object.getOwnPropertyNames(window).filter((k) => /cerea/i.test(k)),
				};
				host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
				(host as HTMLElement).click();
				return seen;
			}, selector())
		);
		assert.equal(outcome.shadow, null);
		assert.deepEqual(outcome.globals, []);
		await sleep(200);
		assert.equal(r.session.live.paused, false);
	});

	it("goes with the task", async () => {
		const page = await r.session.withPage(async (p) => p);
		await r.call("end_task", { keep: true });
		await sleep(300);
		assert.equal(page.isClosed(), false);
		const gone = await page.evaluate((sel) => !document.querySelector(sel), selector());
		assert.equal(gone, true);
	});
});
