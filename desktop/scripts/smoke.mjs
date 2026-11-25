// Starts the real app under xvfb (run through `npm run smoke`, which wraps this in xvfb-run) and
// checks its three parts: the Cerea window, the galopin panel, and the browser panel driven by
// browser-runtime over the bridge. Then it measures idle CPU, visible and hidden.
//
//   SMOKE_IDLE_SECONDS   length of each idle measurement (default 60)
//   IDLE_BUDGET_PERCENT  the hidden-window average CPU must stay under this (default 1)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

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

const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cerea-desktop-smoke-"));
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
writeFileSync(
	join(userData, "config.json"),
	JSON.stringify({ server: { address, origin: address, name: "Smoke Cerea" } })
);

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
const app = spawn(electron, [".", "--no-sandbox", "--disable-gpu"], {
	cwd: root,
	env,
	stdio: ["pipe", "pipe", "pipe"],
});
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
const step = (s) => console.log(`ok  ${s}`);
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

	// 2. galopin panel: the real binary, a temp HOME
	const g = await hook("galopin", "GALOPIN");
	if (g.available) {
		assert.match(g.output, /galopin|run|service|terminal|not/i);
		step(`galopin status ran (${JSON.stringify(g.output.slice(0, 80))})`);
	} else
		console.log("skip galopin status: no resources/galopin/galopin (run `npm run galopin:build`)");

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
	await call("end_task", {});

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
			new Promise((r) => {
				const id = ++nextId;
				pending.set(id, r);
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

	// 4. idle energy: the runtime goes away, then CPU is measured visible and hidden
	await rt.close();
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
}
process.exit(failed ? 1 : 0);
