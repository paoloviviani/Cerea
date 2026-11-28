// Starts the real app under xvfb (run through `npm run smoke`, which wraps this in xvfb-run) and
// checks its three parts: the Cerea window, the galopin panel, and the browser panel driven by
// browser-runtime over the bridge. Then it measures idle CPU, visible and hidden.
//
//   SMOKE_IDLE_SECONDS   length of each idle measurement (default 60)
//   IDLE_BUDGET_PERCENT  the hidden-window average CPU must stay under this (default 1)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const SMOKE_WINDOW = "smokewindow".padEnd(32, "0");
const smokeStates = [];
const upWaiters = new Map();
const downWaiters = [];
const downQueue = [];
const here = import.meta.dirname;
const root = join(here, "..");
const rtDir = join(root, "..", "browser-runtime");
const IDLE_S = Number(process.env.SMOKE_IDLE_SECONDS ?? 60);
const BUDGET = Number(process.env.IDLE_BUDGET_PERCENT ?? 1);

const rtRequire = createRequire(join(rtDir, "package.json"));
const { Client } = await import(rtRequire.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(
	rtRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const { startFixtures } = await import(join(rtDir, "test", "fixtures.ts"));

// A space in the app's data path, as on every Mac ("Application Support"): v0.67.2 shipped a
// browser that could not reach its own panel there. Not in TMPDIR itself: xvfb-run keeps its X
// authority file there and cannot take a space.
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cerea desktop smoke-"));
const home = join(tmp, "home");
const userData = join(tmp, "userdata");
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });

// A stand-in Cerea: what the app asks a server before it trusts it, and a page to show.
const fake = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url === "/galopin/enroll.json")
		send(
			"application/json",
			JSON.stringify({
				issuer: "https://idp.example.org",
				gateway: "https://llm.example.org",
				clientId: "opencode-enrollment",
				// the server names its session cookie; the page never does
				sessionCookie: "hf-chat",
			})
		);
	else if (req.url === "/manifest.webmanifest")
		send("application/manifest+json", JSON.stringify({ name: "Smoke Cerea", icons: [] }));
	else if (req.url === "/smoke/state" && req.method === "POST") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => (smokeStates.push(JSON.parse(body)), res.end("ok")));
	} else if (req.url === "/smoke/up" && req.method === "POST") {
		// What the app sent to the page (answers), as the page relays them to the server.
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const msg = JSON.parse(body);
			(upWaiters.get(msg.id) ?? (() => {}))(msg);
			res.end("ok");
		});
	} else if (req.url === "/smoke/down") {
		// What the server sends to the page: held until there is something to send.
		const give = (m) => res.end(m);
		if (downQueue.length) give(downQueue.shift());
		else downWaiters.push(give);
		res.on("close", () =>
			downWaiters.splice(0, downWaiters.length, ...downWaiters.filter((w) => w !== give))
		);
	} else
		(res.setHeader("set-cookie", "hf-chat=smoke-session-secret; HttpOnly; Path=/"),
			send(
				"text/html",
				`<!doctype html><title>Smoke Cerea page</title><h1>Hello from the fake Cerea</h1>
<script>
// The part of Cerea's page that relays between the server and the app (src/lib/utils/desktopBrowser.ts).
(async () => {
  const b = window.cereaDesktop && window.cereaDesktop.browser;
  await fetch('/smoke/state', { method: 'POST', body: JSON.stringify({ path: location.pathname, exposed: !!b, available: !!(b && b.available), keys: b ? Object.keys(b).sort() : [] }) });
  if (!b || !b.available) return;
  b.onMessage((m) => fetch('/smoke/up', { method: 'POST', body: m }));
  b.send(JSON.stringify({ jsonrpc: '2.0', method: 'cerea/window', params: { windowId: '${SMOKE_WINDOW}' } }));
  for (;;) { const t = await (await fetch('/smoke/down')).text(); if (t) b.send(t); }
})();
</script>`
			));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
// The fake server's side of the window browser link: messages down to the page, answers up.
function serverCall(id, name, args = {}) {
	const reply = new Promise((resolve, reject) => {
		upWaiters.set(id, resolve);
		setTimeout(() => reject(new Error(`no answer to ${name}`)), 60000);
	});
	const text = JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	});
	const w = downWaiters.shift();
	if (w) w(text);
	else downQueue.push(text);
	return reply;
}
const address = `http://127.0.0.1:${fake.address().port}`;
writeFileSync(
	join(userData, "config.json"),
	JSON.stringify({ server: { address, origin: address, name: "Smoke Cerea" } })
);

// A second stand-in Cerea, for the second profile.
const fake2 = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url === "/galopin/enroll.json")
		send(
			"application/json",
			JSON.stringify({
				issuer: "https://idp2.example.org",
				gateway: "https://llm2.example.org",
				clientId: "opencode-enrollment",
			})
		);
	else if (req.url === "/manifest.webmanifest")
		send("application/manifest+json", JSON.stringify({ name: "Home Cerea", icons: [] }));
	else
		send(
			"text/html",
			"<!doctype html><title>Home Cerea page</title><h1>Hello from the second Cerea</h1>"
		);
});
await new Promise((r) => fake2.listen(0, "127.0.0.1", r));
const address2 = `http://127.0.0.1:${fake2.address().port}`;

// A fake identity provider that signs in through a fake upstream one (GitLab through Microsoft),
// and a stand-in Cerea whose first load 302s straight to it: the app must stay in its own window
// through the whole chain, there and back (the sign-in regressions).
const fakeUpstream = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url?.startsWith("/authorize"))
		// The upstream provider's answer goes back to the server's provider by a script (a form post
		// in real life): a navigation, not a redirect.
		send(
			"text/html",
			`<!doctype html><title>Fake upstream page</title><h1>Sign in upstream</h1>
<script>setTimeout(() => { location.href = ${JSON.stringify(`${idpAddress}/callback?code=up`)}; }, 1500);</script>`
		);
	else send("text/html", "<!doctype html><title>Fake upstream</title>");
});
await new Promise((r) => fakeUpstream.listen(0, "127.0.0.1", r));
const upstreamAddress = `http://127.0.0.1:${fakeUpstream.address().port}`;
let address3 = "";
const fakeIdp = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url?.startsWith("/authorize")) {
		res.writeHead(302, { location: `${upstreamAddress}/authorize?client=idp` });
		res.end();
	} else if (req.url?.startsWith("/callback")) {
		res.writeHead(302, { location: `${address3}/signed-in` });
		res.end();
	} else send("text/html", "<!doctype html><title>Fake IdP</title>");
});
await new Promise((r) => fakeIdp.listen(0, "127.0.0.1", r));
const idpAddress = `http://127.0.0.1:${fakeIdp.address().port}`;
const fakeRedirect = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url === "/galopin/enroll.json")
		send(
			"application/json",
			JSON.stringify({
				issuer: `${idpAddress}/`,
				gateway: "https://llm3.example.org",
				clientId: "opencode-enrollment",
				sessionCookie: "hf-chat",
			})
		);
	else if (req.url === "/manifest.webmanifest")
		send("application/manifest+json", JSON.stringify({ name: "Redirect Cerea", icons: [] }));
	else if (req.url === "/") {
		res.writeHead(302, { location: "/login" });
		res.end();
	} else if (req.url === "/login") {
		res.writeHead(302, { location: `${idpAddress}/authorize?client=smoke` });
		res.end();
	} else if (req.url === "/signed-in")
		send("text/html", "<!doctype html><title>Signed in at Redirect Cerea</title>");
	else send("text/html", "<!doctype html><title>Redirect Cerea</title>");
});
await new Promise((r) => fakeRedirect.listen(0, "127.0.0.1", r));
address3 = `http://127.0.0.1:${fakeRedirect.address().port}`;

// A stand-in Cerea that lives under /chat, as the kit deploys it: the profile is added by its
// bare site (the app finds /chat), and the page under /chat must get the app's browser bridge.
const chatStates = [];
const fakeChat = http.createServer((req, res) => {
	const send = (type, body) => (res.setHeader("content-type", type), res.end(body));
	if (req.url === "/chat/galopin/enroll.json")
		send(
			"application/json",
			JSON.stringify({
				issuer: "https://idp4.example.org",
				gateway: "https://llm4.example.org",
				clientId: "opencode-enrollment",
				sessionCookie: "hf-chat",
			})
		);
	else if (req.url === "/chat/manifest.webmanifest")
		send("application/manifest+json", JSON.stringify({ name: "Chat-path Cerea", icons: [] }));
	else if (req.url === "/chat/smoke/state" && req.method === "POST") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => (chatStates.push(JSON.parse(body)), res.end("ok")));
	} else if (req.url === "/chat" || req.url?.startsWith("/chat/") || req.url === "/outside")
		(res.setHeader("set-cookie", "hf-chat=chat-path-secret; HttpOnly; Path=/chat"),
			send(
				"text/html",
				`<!doctype html><title>Chat-path Cerea</title><script>
const b = window.cereaDesktop && window.cereaDesktop.browser;
fetch('/chat/smoke/state', { method: 'POST', body: JSON.stringify({ path: location.pathname, exposed: !!b, available: !!(b && b.available) }) })
  .then(() => { if (location.pathname !== '/outside') location.href = '/outside'; });
</script>`
			));
	else ((res.statusCode = 404), res.end("not here"));
});
await new Promise((r) => fakeChat.listen(0, "127.0.0.1", r));
const address4 = `http://127.0.0.1:${fakeChat.address().port}`;

const fx = await startFixtures();
const galopinBin = join(root, "resources", "galopin", "galopin");
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: join(home, ".config"),
	CEREA_DESKTOP_TEST: "1",
	CEREA_DESKTOP_USER_DATA: userData,
	...(existsSync(galopinBin) ? { GALOPIN_BIN: galopinBin } : {}),
};
const electron = join(root, "node_modules", ".bin", "electron");
// The real renderer sandbox (what every installed app runs with) when Chromium's setuid helper is
// set up (CI does: root-owned, mode 4755); otherwise, on a developer box, --no-sandbox.
const sandboxHelper = join(root, "node_modules", "electron", "dist", "chrome-sandbox");
const sandboxed = (() => {
	try {
		const st = statSync(sandboxHelper);
		return st.uid === 0 && (st.mode & 0o4000) !== 0;
	} catch {
		return false;
	}
})();
if (process.env.SMOKE_REQUIRE_SANDBOX === "1" && !sandboxed)
	throw new Error(`SMOKE_REQUIRE_SANDBOX=1, but ${sandboxHelper} is not root-owned with mode 4755`);
console.log(sandboxed ? "renderer sandbox: on" : "renderer sandbox: off (--no-sandbox)");
const app = spawn(
	electron,
	[".", ...(sandboxed ? [] : ["--no-sandbox"]), "--disable-gpu", "--force-device-scale-factor=1"],
	{
		cwd: root,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	}
);
let out = "";
let errOut = "";
const waiters = [];
app.stdout.on("data", (b) => {
	out += b;
	for (const w of [...waiters]) w();
});
app.stderr.on("data", (b) => (errOut += b));
const waitFor = (re, ms = 20000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`timeout waiting for ${re}\n${out}\n${errOut.slice(-2000)}`)),
			ms
		);
		const check = () => {
			const m = re.exec(out);
			if (m) {
				clearTimeout(t);
				waiters.splice(waiters.indexOf(check), 1);
				resolve(m);
			}
		};
		waiters.push(check);
		check();
	});
async function hook(cmd, tag) {
	const before = out.length;
	app.stdin.write(cmd + "\n");
	if (!tag) return;
	const re = new RegExp(`${tag} (.*)\\n`);
	const start = Date.now();
	for (;;) {
		const m = re.exec(out.slice(before));
		if (m) return JSON.parse(m[1]);
		if (Date.now() - start > 15000) throw new Error(`no ${tag} answer`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
// The fake Cerea sets the session cookie (HttpOnly) the window browser derives its key from; the
// isolation checks below are about the cookies the test sets itself.
const own = (list) =>
	list.map((x) => ({
		...x,
		cerea: x.cerea.filter((n) => n !== "hf-chat" && n !== "smoke-httponly"),
		panel: x.panel.filter((n) => n !== "hf-chat" && n !== "smoke-httponly"),
	}));
const step = (s) => ((lastStep = s), console.log(`ok  ${s}`));
// Nothing here may hang for good: past this the run fails with the last step it reached.
let lastStep = "(none yet)";
setTimeout(() => {
	console.error(`SMOKE FAILED: no end after 10 minutes; last step: ${lastStep}`);
	process.exit(1);
}, 10 * 60_000).unref();
let failed;
let rt;
try {
	const ready = await waitFor(/CEREA_DESKTOP_READY (.*)\n/);
	const endpointFile = ready[1];
	await new Promise((r) => setTimeout(r, 2500)); // let the pages load

	// 1. the local UI and the Cerea window
	const ui = await hook("ui", "UI");
	assert.equal(ui.bridge, "function", "the preload bridge is there");
	assert.equal(ui.setupHidden, true, "the first-run screen is skipped when a server is stored");
	step("local UI loaded, with the preload bridge");
	const cerea = await hook("cerea", "CEREA");
	assert.equal(cerea.url, `${address}/`);
	assert.match(cerea.title, /Smoke Cerea page/);
	step(`Cerea window loaded ${cerea.url}`);

	// 1b. the browser panel is a tool: closed at start, the Cerea view has the whole window
	const SHOTS = process.env.SMOKE_SHOTS ?? "/var/tmp/desktop2-tmp";
	const shot = async (name) => hook(`screenshot ${join(SHOTS, name)}`, "SHOT");
	mkdirSync(SHOTS, { recursive: true });
	let pnl = await hook("panel", "PANEL");
	assert.equal(pnl.open, false, "the panel is closed at start");
	assert.equal(pnl.cereaVisible, true);
	assert.equal(pnl.cerea.width, pnl.content.width, "the Cerea view spans the window");
	assert.equal(pnl.cerea.x, 0);
	assert.match(pnl.menu.accelerator, /Shift\+B/);
	assert.match(pnl.menu.label, /Show Browser/);
	let um = await hook("uimetrics", "UIMETRICS");
	assert.equal(um.side.hidden, true, "the panel is not in the page");
	assert.equal(um.dpr, 1, "device scale factor 1");
	await shot("panel-closed.png");
	step("panel closed at start; the Cerea view spans the window (screenshot panel-closed.png)");

	// 2. galopin panel: the real binary, a temp HOME
	const g = await hook("galopin", "GALOPIN");
	if (g.available) {
		assert.match(g.output, /galopin|run|service|terminal|not/i);
		step(`galopin status ran (${JSON.stringify(g.output.slice(0, 80))})`);
	} else
		console.log("skip galopin status: no resources/galopin/galopin (run `npm run galopin:build`)");

	// 2b. the chat in this window drives the panel directly (ADR 0122): the Cerea page gets the
	// bridge, the page relays the server's messages, the app's own runtime answers on the real panel
	{
		const states = () => smokeStates.filter((x) => x.path === "/");
		for (let i = 0; i < 50 && states().length === 0; i++)
			await new Promise((r) => setTimeout(r, 200));
		const st = states()[0];
		assert.ok(st, "the Cerea page reported what it sees");
		assert.deepEqual(
			st.keys,
			["available", "onMessage", "send"],
			"the page gets exactly the bridge"
		);
		assert.equal(st.available, true, "the app can run a browser for the page");
		const wb = await hook("winbrowser", "WINBROWSER");
		assert.equal(wb.available, true);
		// the app derived this window's grant key from the session cookie (HttpOnly, so not from the page)
		const { createHmac } = await import("node:crypto");
		const { readFileSync } = await import("node:fs");
		const profileId = (await hook("state", "STATE")).profiles[0].id;
		const keyFile = join(userData, "winbrowser", profileId, "approval-key");
		for (let i = 0; i < 50 && !existsSync(keyFile); i++)
			await new Promise((r) => setTimeout(r, 200));
		assert.equal(
			readFileSync(keyFile, "utf8").trim(),
			createHmac("sha256", "smoke-session-secret")
				.update(`cerea-window-grant-key|${SMOKE_WINDOW}`)
				.digest("base64url"),
			"the grant key is the one the server derives"
		);
		step("window browser: the app derived the window's grant key from the session cookie");
		const got = await serverCall("s1", "open", { url: `${fx.base}/form` });
		assert.ok(!got.error, JSON.stringify(got));
		assert.ok(!got.result.isError, JSON.stringify(got.result));
		const token = got.result.structuredContent.token;
		assert.ok((await serverCall("s2", "resume", { token })).result, "resume");
		const nav = await serverCall("s3", "act", {
			actions: [{ type: "navigate", url: `${fx.base}/form` }],
		});
		assert.ok(
			!nav.error && nav.result.structuredContent.results[0].ok === true,
			JSON.stringify(nav)
		);
		const snap = await serverCall("s4", "snapshot");
		assert.ok(!snap.error && !snap.result.isError, JSON.stringify(snap));
		assert.match(snap.result.structuredContent.text, /button "Save"/);
		const tabsNow = await hook("tabs", "TABS");
		assert.ok(
			tabsNow.some((t) => t.url.startsWith(fx.base)),
			"the page is a tab of the panel"
		);
		step("window browser: key, open, resume, navigate and snapshot on the real panel, no galopin");
		// not allowed: a tool the runtime does not have, and a method that is not a call
		const refused = await serverCall("s5", "evaluate", { expression: "1" });
		assert.match(refused.error.message, /tool not allowed/);
		step("window browser: a tool outside the contract is refused by the app");
		// the same hook a galopin task uses: the panel opened on the Browser tab, "working" shows
		{
			const pn = await hook("panel", "PANEL");
			assert.equal(pn.open, true, "a window task opens the panel");
			assert.equal(pn.pane, "browser");
			assert.equal(pn.working, true);
			assert.match((await hook("uimetrics", "UIMETRICS")).tabBrowser, /Browser working/);
			step("window browser: a window task opens the panel on the Browser tab and shows 'working'");
		}
		// the session cookie is HttpOnly: main reads it, the page does not
		{
			const c = await hook("httponly", "HTTPONLY");
			assert.equal(c.value, "secret-value");
			assert.equal(c.httpOnly, true);
			assert.ok(!String(c.page).includes("smoke-httponly"), "document.cookie does not show it");
			step(
				"an HttpOnly cookie in the Cerea partition is readable by main and hidden from the page"
			);
		}
		await serverCall("s6", "end_task", {});
		// the same Cerea page opened in the panel gets no bridge (only the Cerea view has the preload)
		const nav2 = await serverCall("s7", "act", {
			actions: [{ type: "navigate", url: `${address}/in-the-panel` }],
		});
		assert.ok(!nav2.error, JSON.stringify(nav2));
		for (let i = 0; i < 50 && !smokeStates.some((x) => x.path === "/in-the-panel"); i++)
			await new Promise((r) => setTimeout(r, 200));
		const inPanel = smokeStates.find((x) => x.path === "/in-the-panel");
		assert.ok(inPanel, "the page loaded in the panel reported");
		assert.equal(inPanel.exposed, false, "the panel's page, even on Cerea's origin, has no bridge");
		await serverCall("s8", "end_task", {});
		// #377's focus rule holds for the window runtime too (same bridge): with the panel hidden,
		// Page.bringToFront is refused
		await hook("uiclick side-close");
		await new Promise((r) => setTimeout(r, 500));
		assert.equal((await hook("panel", "PANEL")).open, false);
		const via = await serverCall("s9", "open", { url: `${fx.base}/form` });
		assert.ok(!via.error, JSON.stringify(via));
		const { WebSocket } = await import("ws");
		// a second runtime (a galopin task, say) while the window's task is running is refused, not let
		// in: it is closed at once with the reason, and the running task is not cut off
		{
			const ws = new WebSocket(readFileSync(endpointFile, "utf8").trim());
			const closedWith = await new Promise((r, j) => {
				const t = setTimeout(
					() => j(new Error("a second runtime was neither served nor refused")),
					10_000
				);
				ws.once(
					"close",
					(code, reason) => (clearTimeout(t), r({ code, reason: reason.toString() }))
				);
				ws.once("error", () => undefined);
			});
			assert.equal(closedWith.reason, "Another task is using this browser.");
			const still = await serverCall("s9b", "snapshot", {});
			assert.ok(!still.error && !still.result.isError, "the running window task was not cut off");
			step("window browser: a second runtime is refused while a task runs, and the task goes on");
		}
		// "working" ends after 30 s without a sign of life: then the panel takes a runtime again
		await new Promise((r) => setTimeout(r, 31_000));
		{
			const ws = new WebSocket(readFileSync(endpointFile, "utf8").trim());
			await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
			let session;
			const pending = new Map();
			let n = 0;
			ws.on("message", (m) => {
				const d = JSON.parse(m.toString());
				if (d.method === "Target.attachedToTarget" && !session) session = d.params.sessionId;
				if (d.id && pending.has(d.id)) pending.get(d.id)(d);
			});
			const send = (method, params = {}, sessionId) =>
				new Promise((r, j) => {
					const id = ++n;
					const t = setTimeout(() => j(new Error(`no answer to ${method}`)), 10_000);
					pending.set(id, (d) => (clearTimeout(t), r(d)));
					ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
				});
			await send("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			await new Promise((r) => setTimeout(r, 500));
			assert.ok(session, "a session on a panel page");
			// the first command started a task and opened the panel: hide it again (same task, so it stays
			// hidden), as a user who closed the panel mid-task would
			await hook("uiclick side-close");
			await new Promise((r) => setTimeout(r, 500));
			assert.equal((await hook("panel", "PANEL")).open, false);
			const r = await send("Page.bringToFront", {}, session);
			assert.match(r.error?.message ?? "", /not showing/, "bringToFront is refused while hidden");
			ws.close();
		}
		step("window browser: Page.bringToFront is refused while the panel is hidden");
		step("window browser: the panel's own page, on Cerea's origin, gets no bridge");
		// "working" ends after 30 s without a sign of life: wait it out so the next part sees a fresh task
		await new Promise((r) => setTimeout(r, 31_000));
		await hook('panelset {"open":false}');
	}

	// 3. the browser panel, driven by browser-runtime over the bridge
	rt = new Client({ name: "smoke", version: "1" });
	await rt.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [
				join(rtDir, "src", "main.ts"),
				"--connect-file",
				endpointFile,
				"--state-dir",
				join(tmp, "rtstate"),
				"--pace",
				"off",
			],
			stderr: "inherit",
		})
	);
	const call = async (name, args = {}) => rt.callTool({ name, arguments: args });
	const opened = await call("open", { url: `${fx.base}/form` });
	assert.ok(!opened.isError, JSON.stringify(opened.content));
	const token = opened.structuredContent.token;
	assert.ok(!(await call("resume", { token })).isError);
	const snap = await call("snapshot");
	assert.ok(!snap.isError, JSON.stringify(snap.content));
	assert.match(snap.structuredContent.text, /button "Save"/);
	step("open + resume + snapshot through the bridge");

	// 2b. the runtime starting on a task opened the panel, and the Cerea view made room
	await new Promise((r) => setTimeout(r, 800));
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.open, true, "a task opens the panel");
	assert.equal(pnl.pane, "browser");
	assert.equal(pnl.cerea.width + pnl.panelRect.width, pnl.content.width, "window = chat + panel");
	assert.ok(pnl.cerea.x + pnl.cerea.width <= pnl.panelRect.x, "no overlap");
	assert.equal(pnl.working, true);
	um = await hook("uimetrics", "UIMETRICS");
	assert.equal(um.side.hidden, false);
	assert.match(um.tabBrowser, /Browser working/);
	assert.ok(
		Math.abs(um.side.w - pnl.panelRect.width) <= 1 && Math.abs(um.side.x - pnl.panelRect.x) <= 1,
		"the page's panel is where the layout says"
	);
	await shot("panel-open.png");
	step(
		"a runtime task opens the panel without overlap, and the toggle shows 'Browser working' (screenshot panel-open.png)"
	);

	// closing hides the panel and the task goes on
	await hook("uiclick side-close");
	await new Promise((r) => setTimeout(r, 500));
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.open, false, "the close button hides the panel");
	assert.equal(pnl.cerea.width, pnl.content.width, "the Cerea view takes the room back");
	const stillGoing = await call("snapshot");
	assert.ok(!stillGoing.isError, "the task keeps going with the panel closed");
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.open, false, "more activity of the same task does not reopen it");
	assert.equal(pnl.working, true);
	step("the close button hides the panel; the task goes on and does not reopen it");

	// the shortcut toggles it; a resize keeps the room, the width is clamped
	await hook("key control+shift+b");
	await new Promise((r) => setTimeout(r, 400));
	pnl = await hook("panel", "PANEL");
	if (!pnl.open) {
		console.log(
			"note: a synthetic key event did not reach the menu accelerator under Xvfb; using the menu item itself"
		);
		await hook("togglemenu");
		await new Promise((r) => setTimeout(r, 300));
		pnl = await hook("panel", "PANEL");
	}
	assert.equal(pnl.open, true, "Ctrl+Shift+B opens the panel");
	assert.match(pnl.menu.label, /Hide Browser/);
	await hook("togglemenu");
	await new Promise((r) => setTimeout(r, 300));
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.open, false, "the same item closes it");
	await hook("togglemenu");
	await hook('panelset {"width":600}');
	await new Promise((r) => setTimeout(r, 300));
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.panelRect.width, 600);
	assert.equal(pnl.cerea.width, pnl.content.width - 600);
	await hook('panelset {"width":50}');
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.panelRect.width, 360, "never narrower than 360 px");
	await hook('panelset {"width":99999}');
	pnl = await hook("panel", "PANEL");
	assert.equal(pnl.panelRect.width, Math.floor(pnl.content.width * 0.7), "never wider than 70%");
	await hook("size 900 560");
	await new Promise((r) => setTimeout(r, 400));
	pnl = await hook("panel", "PANEL");
	assert.equal(
		pnl.cerea.width + pnl.panelRect.width,
		900,
		"at the smallest size the chat and the panel still share the window"
	);
	assert.ok(pnl.cerea.width >= 270);
	await hook('panelset {"width":440}');
	await hook("size 1360 860");
	await hook('panelset {"open":false}');
	step(
		"the shortcut and the menu item toggle it; the width is clamped; at 900x560 nothing overlaps"
	);

	const field = snap.structuredContent.elements.find((e) => e.name === "Full name");
	const fill = await call("act", { actions: [{ type: "fill", ref: field.ref, text: "Ada" }] });
	assert.equal(fill.structuredContent.results[0].ok, true, JSON.stringify(fill.structuredContent));
	step("act (fill) through the bridge");
	const tabs = await hook("tabs", "TABS");
	assert.ok(
		tabs.some((t) => t.url.startsWith(fx.base)),
		"the page is a tab of the panel"
	);
	const listed = JSON.stringify((await call("tabs")).structuredContent);
	assert.ok(!listed.includes(address), "the Cerea window is not among the tabs the runtime sees");
	assert.ok(!tabs.some((t) => t.url.startsWith(address)), "and not among the panel's tabs");
	step("the runtime sees the panel's pages and never the Cerea window");

	// take over: the runtime is cut off, the user navigates freely, the runtime sees nothing
	await hook("control user");
	await new Promise((r) => setTimeout(r, 500));
	const driver = await call("control");
	assert.equal(driver.structuredContent.state, "user", "the runtime is told the user is driving");
	const blocked = await call("act", { actions: [{ type: "fill", ref: field.ref, text: "Grace" }] });
	assert.ok(
		blocked.isError || blocked.structuredContent?.results?.[0]?.ok !== true,
		"an action while the user drives must not run"
	);
	await hook(`usernav ${fx.base}/staff`);
	await new Promise((r) => setTimeout(r, 1500));
	const userTabs = await hook("tabs", "TABS");
	assert.ok(
		userTabs.some((t) => t.url.includes("/staff")),
		"the user can browse while they drive"
	);
	const during = JSON.stringify((await call("tabs").catch(() => ({}))).structuredContent ?? {});
	assert.ok(
		!during.includes("/staff") && !during.includes("/form"),
		"the runtime sees none of the user's pages while they drive"
	);
	setTimeout(() => void hook("control agent"), 300);
	const back = await call("control", { wait: true });
	assert.equal(back.structuredContent.state, "agent", "control waits for the hand-back");
	await new Promise((r) => setTimeout(r, 1500));
	const after = (await call("tabs")).structuredContent.tabs;
	assert.ok(
		after.some((t) => t.url.includes("/staff") && t.mine === false),
		"after hand-back the pages are the user's tabs"
	);
	step(
		"take over cuts the runtime off (it sees nothing the user does); hand back shows the pages as the user's tabs"
	);

	// the Home button navigates the panel back to the profile's home page
	const uiAway = await hook("ui", "UI");
	assert.equal(uiAway.homeHidden, false, "the Home button is shown away from home");
	await hook("uiclick nav-home");
	await new Promise((r) => setTimeout(r, 1500));
	const homedTabs = await hook("tabs", "TABS");
	assert.ok(
		homedTabs.some((t) => t.active && t.url === `${address}/chat`),
		`the Home button navigated the active tab home: ${JSON.stringify(homedTabs)}`
	);
	const uiHome = await hook("ui", "UI");
	assert.equal(uiHome.homeHidden, true, "the Home button is hidden at home");
	step("the Home button navigates the panel back to the profile's home page");

	await call("end_task", {});
	// The raw clients below stand in for other runtimes, and the bridge refuses a second runtime while
	// the first has a task: this one is done, so it goes (its connection ends).
	await rt.close();
	rt = undefined;

	// a runtime with the right secret still cannot reach another web contents (raw CDP, as an attacker would)
	{
		const fs = await import("node:fs");
		const { WebSocket } = await import("ws");
		const ep = fs.readFileSync(endpointFile, "utf8").trim();
		const ws = new WebSocket(ep);
		await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
		let nextId = 0;
		const pending = new Map();
		let session;
		ws.on("message", (m) => {
			const d = JSON.parse(m.toString());
			if (d.method === "Target.attachedToTarget" && !session) session = d.params.sessionId;
			if (d.id && pending.has(d.id)) pending.get(d.id)(d);
		});
		const send = (method, params = {}, sessionId) =>
			new Promise((r, j) => {
				const id = ++nextId;
				const t = setTimeout(() => j(new Error(`no answer to ${method}`)), 10_000);
				pending.set(id, (d) => (clearTimeout(t), r(d)));
				ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			});
		await send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		await new Promise((r) => setTimeout(r, 500));
		assert.ok(session, "a session on a panel page");
		const real = await hook("targetids", "TARGETIDS");
		const ui = real.find((t) => t.url.startsWith("app://ui"));
		const cerea = real.find((t) => t.url.startsWith(address));
		assert.ok(ui && cerea, "the UI's and the Cerea view's real target ids");
		const refused = async (m, p, re) => {
			const r = await send(m, p, session);
			assert.ok(r.error, `${m} must be refused`);
			assert.match(r.error.message, re, `${m}: the policy's own refusal, not some other failure`);
		};
		await refused("Target.getTargets", {}, /not available here/);
		await refused(
			"Target.attachToTarget",
			{ targetId: ui.id, flatten: true },
			/not available here/
		);
		await refused(
			"Target.attachToTarget",
			{ targetId: cerea.id, flatten: true },
			/not available here/
		);
		await refused("Storage.getCookies", {}, /not available here/);
		await refused("SystemInfo.getInfo", {}, /not available here/);
		await refused("Page.navigate", { url: "file:///etc/hostname" }, /Only web pages/);
		await refused(
			"Input.dispatchDragEvent",
			{ type: "drop", x: 1, y: 1, data: { items: [], files: ["/etc/hostname"] } },
			/Dropping files/
		);
		await refused("DOM.setFileInputFiles", { files: ["/etc/hostname"] }, /not available here/);
		// the same ids over the browser-level connection: no session can be made on them either
		const viaBrowser = await send("Target.attachToTarget", { targetId: ui.id, flatten: true });
		assert.ok(viaBrowser.error, "no browser-level attach to the UI");
		ws.close();
		step(
			"a connected runtime cannot list, attach to or navigate to anything but the panel's web pages"
		);
	}

	// a wrong secret is refused
	const badEndpoint = (await import("node:fs"))
		.readFileSync(endpointFile, "utf8")
		.trim()
		.replace(/\/cdp\/.*/, "/cdp/wrong");
	const { chromium } = createRequire(join(rtDir, "package.json"))("playwright-core");
	await assert.rejects(chromium.connectOverCDP(badEndpoint, { timeout: 5000 }));
	step("a connection with the wrong secret is refused");

	// 3b. profiles: the stored single-server config became profile 1; add, switch, switch back
	{
		const { WebSocket } = await import("ws");
		const fs = await import("node:fs");
		let st = await hook("state", "STATE");
		assert.equal(st.profiles.length, 1, "the earlier single-server config became one profile");
		assert.equal(st.profiles[0].active, true);
		assert.match(st.profiles[0].id, /^[a-f0-9]{12}$/);
		await hook("cookie work", "COOKIES");
		// a runtime connection on the first profile's panel, to be cut off by the switch
		const ep = fs.readFileSync(endpointFile, "utf8").trim();
		const ws = new WebSocket(ep);
		await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
		let oldSession;
		let closed = false;
		ws.on("close", () => (closed = true));
		ws.on("message", (m) => {
			const d = JSON.parse(m.toString());
			if (d.method === "Target.attachedToTarget" && !oldSession) oldSession = d.params.sessionId;
		});
		ws.send(
			JSON.stringify({
				id: 1,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, flatten: true },
			})
		);
		await new Promise((r) => setTimeout(r, 600));
		assert.ok(oldSession, "a session on the first profile's panel");

		// add (the new profile becomes active)
		const added = await hook(`addprofile ${address2}`, "PROFILES");
		assert.equal(added.length, 2, JSON.stringify(added));
		assert.equal(added[1].active, true, "adding a profile switches to it");
		assert.equal(added[1].name, "Home Cerea");
		await new Promise((r) => setTimeout(r, 2000));
		const second = await hook("cerea", "CEREA");
		assert.equal(second.url, `${address2}/`);
		assert.match(second.title, /Home Cerea page/);
		assert.ok(closed, "the switch closed the runtime's connection to the old profile's panel");
		step("add profile: switched to the second server, the first panel's connection was cut");

		// isolation: a cookie set in the first profile is not in the second, and the panels are separate too
		let cookies = own(await hook("cookie -", "COOKIES"));
		assert.deepEqual(cookies[0].cerea, ["work"]);
		assert.deepEqual(cookies[0].panel, ["work-panel"]);
		assert.deepEqual(cookies[1].cerea, []);
		assert.deepEqual(cookies[1].panel, []);
		cookies = own(await hook("cookie home", "COOKIES"));
		assert.deepEqual(cookies[1].cerea, ["home"]);
		assert.deepEqual(cookies[0].cerea, ["work"], "the first profile's cookies are untouched");
		step(
			"sessions are separate: a cookie in one profile is not in the other, Cerea window or panel"
		);

		// the old profile's own secret is refused now (a galopin of that profile outside the app cannot drive this panel)
		const refusedOld = await new Promise((resolve) => {
			const w = new WebSocket(ep);
			w.on("unexpected-response", (_q, res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(`${res.statusCode} ${body}`));
			});
			w.on("open", () => resolve("OPENED"));
			w.on("error", () => {});
		});
		assert.equal(refusedOld, "403 This browser belongs to another profile.");
		// the new profile has its own endpoint file in its own galopin directory
		const eps = await hook("endpoints", "ENDPOINTS");
		assert.notEqual(eps[0], eps[1]);
		assert.ok(
			eps[1].includes("/profiles/"),
			"the second profile's endpoint is in its own directory"
		);
		const ep2 = fs.readFileSync(eps[1], "utf8").trim();
		assert.notEqual(ep2, ep);
		// and the old session id means nothing to the new profile's panel
		const ws2 = new WebSocket(ep2);
		await new Promise((r, j) => (ws2.once("open", r), ws2.once("error", j)));
		const reply = await new Promise((resolve) => {
			ws2.on("message", (m) => {
				const d = JSON.parse(m.toString());
				if (d.id === 7) resolve(d);
			});
			ws2.send(
				JSON.stringify({
					id: 7,
					method: "Runtime.evaluate",
					params: { expression: "location.href" },
					sessionId: oldSession,
				})
			);
		});
		assert.match(
			reply.error?.message ?? "",
			/No session/,
			"a command aimed at the old profile's page is refused"
		);
		ws2.close();
		step(
			"each profile has its own bridge secret; the inactive one is refused, and the old session id is refused"
		);

		// switch back: the first server, its sessions intact
		const back = await hook("switchprofile 0", "PROFILES");
		assert.equal(back[0].active, true);
		await new Promise((r) => setTimeout(r, 2000));
		const first = await hook("cerea", "CEREA");
		assert.equal(first.url, `${address}/`);
		cookies = own(await hook("cookie -", "COOKIES"));
		assert.deepEqual(cookies[0].cerea, ["work"], "signed-in state survives a round trip");
		// and the runtime reaches the first profile's (new, empty) panel again
		rt = new Client({ name: "smoke2", version: "1" });
		await rt.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [
					join(rtDir, "src", "main.ts"),
					"--connect-file",
					endpointFile,
					"--state-dir",
					join(tmp, "rtstate2"),
					"--pace",
					"off",
				],
				stderr: "inherit",
			})
		);
		const again = await rt.callTool({ name: "open", arguments: { url: `${fx.base}/form` } });
		assert.ok(!again.isError, JSON.stringify(again.content));
		await rt.close();
		rt = undefined;
		step(
			"switch back: the first server and its sessions are as they were, and the runtime drives its panel again"
		);

		// 3b. the first sign-in: a profile whose server 302s straight to its identity provider stays
		// in the app window through the whole chain (the regression: the window used to stay blank
		// and the system browser took the sign-in).
		const added3 = await hook(`addprofile ${address3}`, "PROFILES");
		assert.equal(added3.length, 3, JSON.stringify(added3));
		assert.equal(added3[2].name, "Redirect Cerea");
		assert.equal(added3[2].active, true, "adding the profile switches to it");
		const until = async (pred, what) => {
			let c;
			for (let i = 0; i < 80; i++) {
				c = await hook("cerea", "CEREA");
				if (pred(c)) return c;
				await new Promise((r) => setTimeout(r, 250));
			}
			assert.fail(`${what}: the Cerea view is at ${JSON.stringify(c)}`);
		};
		// server -> provider -> upstream provider (a third origin, by the provider's redirect)
		const upstream = await until(
			(c) => String(c.url ?? "").startsWith(upstreamAddress),
			"the Cerea view reached the upstream provider through the server's provider"
		);
		assert.match(upstream.title, /Fake upstream page/);
		// upstream -> provider (by a script) -> server (by a redirect): home, signed in
		const home = await until(
			(c) => c.url === `${address3}/signed-in`,
			"the sign-in came back to the server in the app window"
		);
		assert.match(home.title, /Signed in at Redirect Cerea/);
		const back3 = await hook("switchprofile 0", "PROFILES");
		assert.equal(back3[0].active, true);
		await new Promise((r) => setTimeout(r, 2000));
		const backCereA = await hook("cerea", "CEREA");
		assert.equal(backCereA.url, `${address}/`);
		step("first sign-in: server, provider, upstream provider and back, all in the app window");
		// 3c. a Cerea under /chat, added by its bare site: stored with /chat, and the page there gets
		// the app's own browser (the bridge's origin and base-path checks, end to end)
		const added4 = await hook(`addprofile ${address4}`, "PROFILES");
		assert.ok(Array.isArray(added4), JSON.stringify(added4));
		const p4 = added4[added4.length - 1];
		assert.equal(p4.active, true, "adding the profile switches to it");
		assert.equal(p4.address, `${address4}/chat`, "the profile is stored with its base path");
		for (let i = 0; i < 60 && chatStates.length < 2; i++)
			await new Promise((r) => setTimeout(r, 250));
		assert.deepEqual(
			chatStates[0],
			{ path: "/chat/", exposed: true, available: true },
			"the page under /chat gets the app's browser"
		);
		// the same server outside the base path (the page went there itself): no bridge
		assert.deepEqual(
			chatStates[1],
			{ path: "/outside", exposed: false, available: false },
			"a page of the same server outside /chat gets no bridge"
		);
		const wb4 = await hook("winbrowser", "WINBROWSER");
		assert.equal(wb4.available, true, "the app can run a browser for the /chat profile");
		await hook("switchprofile 0", "PROFILES");
		await new Promise((r) => setTimeout(r, 1500));
		step("a Cerea under /chat, added by its bare site, gets the app's own browser");
	}

	// 4. idle energy: the runtime goes away, then CPU is measured visible and hidden
	await rt?.close();
	rt = undefined;
	await new Promise((r) => setTimeout(r, 3000));
	const cpuOf = (m) => m.cpu.reduce((a, p) => a + p.cpu, 0);
	async function measure(label) {
		const a = await hook("metrics", "METRICS");
		await new Promise((r) => setTimeout(r, IDLE_S * 1000));
		const b = await hook("metrics", "METRICS");
		const pct = ((cpuOf(b) - cpuOf(a)) / ((b.at - a.at) / 1000)) * 100;
		const procs = b.cpu.map((p) => p.type).join(",");
		console.log(
			`idle ${label}: ${pct.toFixed(2)}% of one core over ${((b.at - a.at) / 1000).toFixed(0)} s (processes: ${procs})`
		);
		return pct;
	}
	const visible = await measure("visible ");
	await hook("hide");
	await new Promise((r) => setTimeout(r, 3000));
	const hidden = await measure("hidden  ");
	assert.ok(hidden < BUDGET, `hidden idle CPU ${hidden.toFixed(2)}% exceeds ${BUDGET}%`);
	step(`hidden idle CPU ${hidden.toFixed(2)}% < ${BUDGET}% (visible ${visible.toFixed(2)}%)`);
	console.log("SMOKE OK");
} catch (e) {
	failed = e;
	console.error("SMOKE FAILED:", e?.stack ?? e);
} finally {
	await rt?.close().catch(() => {});
	app.kill("SIGTERM");
	await fx.close?.();
	fake.close();
	fake2.close();
	fakeRedirect.close();
	fakeIdp.close();
	fakeUpstream.close();
	fakeChat.close();
}
process.exit(failed ? 1 : 0);
