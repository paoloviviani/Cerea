// Second smoke test: the layout of the window (first run at the smallest size, the divider, the three
// tabs of the side area) and what has to survive a restart. Run under xvfb: `npm run smoke`.
//
//   SMOKE_SHOTS  where screenshots go (default /var/tmp/desktop2-tmp), device scale factor 1
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const SHOTS = process.env.SMOKE_SHOTS ?? "/var/tmp/desktop2-tmp";
mkdirSync(SHOTS, { recursive: true });
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cerea-desktop-smoke2-"));

const fake = http.createServer((req, res) => {
	const send = (t, b) => (res.setHeader("content-type", t), res.end(b));
	if (req.url === "/galopin/enroll.json")
		send(
			"application/json",
			JSON.stringify({
				issuer: "https://idp.example.org",
				gateway: "https://llm.example.org",
				clientId: "opencode-enrollment",
			})
		);
	else if (req.url === "/manifest.webmanifest")
		send("application/manifest+json", JSON.stringify({ name: "Smoke Cerea", icons: [] }));
	else
		send(
			"text/html",
			"<!doctype html><title>Smoke Cerea page</title><h1>Hello from the fake Cerea</h1>"
		);
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const address = `http://127.0.0.1:${fake.address().port}`;

function launch(userData, env = {}) {
	const home = join(tmp, "home");
	mkdirSync(home, { recursive: true });
	const child = spawn(
		join(root, "node_modules", ".bin", "electron"),
		[".", "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1"],
		{
			cwd: root,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				CEREA_DESKTOP_TEST: "1",
				CEREA_DESKTOP_USER_DATA: userData,
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		}
	);
	let out = "";
	child.stdout.on("data", (b) => (out += b));
	child.stderr.on("data", () => {});
	const ready = (async () => {
		for (let i = 0; i < 200; i++) {
			if (/CEREA_DESKTOP_READY/.test(out)) return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`the app did not start\n${out}`);
	})();
	async function hook(cmd, tag) {
		const before = out.length;
		child.stdin.write(cmd + "\n");
		if (!tag) return;
		const re = new RegExp(`${tag} (.*)\\n`);
		for (let i = 0; i < 150; i++) {
			const m = re.exec(out.slice(before));
			if (m) return JSON.parse(m[1]);
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`no ${tag} answer`);
	}
	const stop = () =>
		new Promise((resolve) => {
			child.once("exit", resolve);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 8000).unref();
		});
	return { ready, hook, stop };
}
const step = (s) => console.log(`ok  ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed;
try {
	// ---- 1. first run, at the smallest window size: nothing clipped, no panel
	{
		const app = launch(join(tmp, "ud-first"));
		await app.ready;
		await app.hook("size 900 560");
		await wait(600);
		let p = await app.hook("panel", "PANEL");
		assert.equal(p.open, false, "no panel on the first-run screen");
		assert.equal(p.cerea, null, "no Cerea view before a server is chosen");
		await app.hook(
			`uieval document.getElementById('setup-address').value = ${JSON.stringify(address)}; document.getElementById('setup-form').requestSubmit(); await new Promise(r => setTimeout(r, 1500)); return 1`,
			"UIEVAL"
		);
		await app.hook("panelset " + JSON.stringify({ open: true }));
		await wait(300);
		p = await app.hook("panel", "PANEL");
		assert.equal(p.open, false, "the panel cannot be opened before a server is chosen");
		const m = await app.hook("uimetrics", "UIMETRICS");
		assert.equal(m.side.hidden, true);
		assert.equal(m.setup.hidden, false);
		assert.equal(m.win.w, 900);
		assert.ok(
			m.setupScroll.sw <= m.setupScroll.cw,
			"the first-run screen is not wider than the window"
		);
		assert.ok(
			m.use && m.use.x >= 0 && m.use.x + m.use.w <= 900,
			`the "Use this server" button is inside the window (${JSON.stringify(m.use)})`
		);
		assert.ok(m.use.y + m.use.h <= 560, "and above the bottom edge, or the screen scrolls");
		await app.hook(`screenshot ${join(SHOTS, "first-run-900x560.png")}`, "SHOT");
		step("first run at 900x560: no panel, nothing clipped (first-run-900x560.png)");
		await app.stop();
	}

	// ---- 2. the divider, the tabs, and a restart
	const ud = join(tmp, "ud-main");
	mkdirSync(ud, { recursive: true });
	writeFileSync(
		join(ud, "config.json"),
		JSON.stringify({ server: { address, origin: address, name: "Smoke Cerea" } })
	);
	let draggedTo;
	{
		// shown, so that the window can hold keyboard focus (a hidden window has none)
		const app = launch(ud, { CEREA_DESKTOP_SHOW: "1" });
		await app.ready;
		await wait(2000);
		let p = await app.hook("panel", "PANEL");
		assert.equal(p.open, false, "closed at start");
		await app.hook("panelset " + JSON.stringify({ open: true, pane: "browser" }));
		await wait(500);
		p = await app.hook("panel", "PANEL");
		const startWidth = p.panelRect.width;
		assert.equal(startWidth, 440);
		let m = await app.hook("uimetrics", "UIMETRICS");
		assert.ok(m.handle.w >= 6, "the divider's hit area is at least 6 px");
		const hx = m.handle.x + 3;

		// drag it left by 120: the HTML panel and the Cerea view change together
		await app.hook(`mouse mouseDown ${hx} 300 1`);
		await app.hook(`mouse mouseMove ${hx - 60} 300`);
		await app.hook(`mouse mouseMove ${hx - 120} 300`);
		await wait(400);
		await app.hook(`mouse mouseUp ${hx - 120} 300`);
		await wait(400);
		p = await app.hook("panel", "PANEL");
		m = await app.hook("uimetrics", "UIMETRICS");
		draggedTo = p.panelRect.width;
		assert.equal(draggedTo, startWidth + 120, "dragging left widens the panel");
		assert.equal(
			p.cerea.width,
			p.content.width - draggedTo,
			"the Cerea view narrowed by the same amount"
		);
		assert.ok(
			Math.abs(m.side.w - draggedTo) <= 1 && Math.abs(m.side.x - p.panelRect.x) <= 1,
			"the HTML panel is where the layout says"
		);
		step(
			`dragging the divider moves the panel and the Cerea view together (${startWidth} -> ${draggedTo})`
		);

		// keyboard, double-click, limits
		await app.hook("uieval document.getElementById('side-handle').focus(); return 1", "UIEVAL");
		await app.hook("keydown Left");
		await wait(300);
		p = await app.hook("panel", "PANEL");
		assert.equal(p.panelRect.width, draggedTo + 20, "the left arrow widens it by 20");
		await app.hook("keydown Right");
		await wait(300);
		await app.hook(`mouse mouseDown ${hx - 120} 300 2`);
		await app.hook(`mouse mouseUp ${hx - 120} 300 2`);
		await app.hook(
			"uieval document.getElementById('side-handle').dispatchEvent(new MouseEvent('dblclick')); return 1",
			"UIEVAL"
		);
		await wait(400);
		p = await app.hook("panel", "PANEL");
		assert.equal(p.panelRect.width, 440, "double-click resets to the default width");
		await app.hook("panelset " + JSON.stringify({ width: draggedTo }));
		await wait(300);
		step("arrow keys resize, double-click resets");

		// the three tabs of the side area: only the active one is visible; the browser's view never covers the others
		await app.hook(`usernav ${address}/`);
		await wait(1500);
		p = await app.hook("panel", "PANEL");
		assert.ok(p.views.length >= 1, "a page in the browser");
		assert.ok(
			p.views.some((v) => v.visible && v.bounds.width > 0),
			"the browser tab shows its page"
		);
		const v = p.views.find((x) => x.visible);
		assert.ok(
			v.bounds.x >= p.panelRect.x &&
				v.bounds.x + v.bounds.width <= p.panelRect.x + p.panelRect.width,
			"inside the panel"
		);
		await app.hook(`screenshot ${join(SHOTS, "tab-browser-open.png")}`, "SHOT");

		// a hidden page must not keep the keyboard: focus in a page, hide the panel, focus is the chat's
		await app.hook("focuspage");
		await wait(300);
		p = await app.hook("panel", "PANEL");
		assert.ok(
			p.focus.pages.length >= 1,
			"a page of the browser holds focus while the panel shows it"
		);
		await app.hook("panelset " + JSON.stringify({ open: false }));
		await wait(500);
		p = await app.hook("panel", "PANEL");
		assert.deepEqual(p.focus.pages, [], "hiding the panel took the keyboard from the page");
		assert.equal(p.focus.cerea, true, "and gave it to the chat");
		await app.hook("pagefocusjs"); // a hidden page calling window.focus()
		await wait(500);
		p = await app.hook("panel", "PANEL");
		assert.deepEqual(p.focus.pages, [], "a hidden page cannot take focus back");
		assert.equal(p.focus.cerea, true);
		await app.hook("panelset " + JSON.stringify({ open: true, pane: "browser" }));
		await wait(400);
		step(
			"hiding the panel moves keyboard focus to the chat, and a hidden page cannot take it back"
		);
		for (const pane of ["galopin", "server"]) {
			await app.hook("panelset " + JSON.stringify({ open: true, pane }));
			await wait(600);
			p = await app.hook("panel", "PANEL");
			assert.equal(p.pane, pane);
			for (const view of p.views) {
				assert.equal(view.visible, false, `the browser's view is hidden on the ${pane} tab`);
				assert.equal(view.bounds.width * view.bounds.height, 0, "and takes no room");
			}
			m = await app.hook("uimetrics", "UIMETRICS");
			assert.equal(m.side.hidden, false);
			await app.hook(`screenshot ${join(SHOTS, `tab-${pane}-open.png`)}`, "SHOT");
		}
		await app.hook("panelset " + JSON.stringify({ open: false }));
		await wait(400);
		p = await app.hook("panel", "PANEL");
		assert.ok(
			p.views.every((x) => !x.visible),
			"closed: no browser view shows"
		);
		await app.hook(`screenshot ${join(SHOTS, "panel-closed-2.png")}`, "SHOT");
		step(
			"browser, galopin and Profiles are separate views of one side area: only the active one shows; screenshots tab-*.png"
		);
		await app.stop(); // before-quit writes the width
	}
	{
		const app = launch(ud);
		await app.ready;
		await wait(1500);
		let p = await app.hook("panel", "PANEL");
		assert.equal(p.open, false, "a fresh start is closed");
		await app.hook("panelset " + JSON.stringify({ open: true }));
		await wait(300);
		p = await app.hook("panel", "PANEL");
		assert.equal(p.panelRect.width, draggedTo, "the dragged width survived the restart");
		step("the width survives a restart; a fresh start is closed");
		await app.stop();
	}

	// ---- 3. a pairing made for another server is not this profile's
	{
		const ud3 = join(tmp, "ud-pair");
		mkdirSync(ud3, { recursive: true });
		writeFileSync(
			join(ud3, "config.json"),
			JSON.stringify({
				server: { address, origin: address, name: "Smoke Cerea", idp: "https://idp.example.org" },
			})
		);
		const home = join(tmp, "home");
		const def = join(home, ".config", "galopin");
		mkdirSync(def, { recursive: true });
		const creds = join(def, "credentials.json");
		writeFileSync(
			creds,
			JSON.stringify({
				cerea_origin: "https://chat-dev.other.example/chat",
				issuer: "https://auth.other.example",
			})
		);
		const before = readFileSync(creds, "utf8");
		const app = launch(ud3);
		await app.ready;
		await wait(1500);
		const info = await app.hook("galopininfo", "GINFO");
		assert.equal(info.pairing, "none", "another server's pairing is not this profile's");
		const cfg = JSON.parse(readFileSync(join(ud3, "config.json"), "utf8"));
		assert.equal(
			cfg.profiles[0].defaultGalopin,
			false,
			"the profile gave up galopin's default directory"
		);
		assert.equal(readFileSync(creds, "utf8"), before, "the other pairing is untouched");
		await app.hook("panelset " + JSON.stringify({ open: true, pane: "galopin" }));
		await wait(1200);
		const txt = await app.hook(
			"uieval return document.getElementById('g-headline').textContent",
			"UIEVAL"
		);
		assert.match(txt, /Not paired with Smoke Cerea/);
		await app.hook(`screenshot ${join(SHOTS, "galopin-not-paired.png")}`, "SHOT");
		step(
			"a pairing for another server is not used, not overwritten, and the card says Not paired (galopin-not-paired.png)"
		);
		await app.stop();
	}
	console.log("SMOKE2 OK");
} catch (e) {
	failed = e;
	console.error("SMOKE2 FAILED:", e?.stack ?? e);
} finally {
	fake.close();
}
process.exit(failed ? 1 : 0);
