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

	// take over and hand back
	await hook("control user");
	await new Promise((r) => setTimeout(r, 300));
	const blocked = await call("act", { actions: [{ type: "fill", ref: field.ref, text: "Grace" }] });
	const blockedText = JSON.stringify(blocked);
	assert.match(blockedText, /taken over|user|fail|ok":false/i, blockedText);
	assert.ok(
		!(blocked.structuredContent?.results?.[0]?.ok === true),
		"an action while the user drives must not run"
	);
	await hook("control agent");
	await new Promise((r) => setTimeout(r, 300));
	const snap2 = await call("snapshot");
	const fill2 = await call("act", {
		actions: [
			{
				type: "fill",
				ref: snap2.structuredContent.elements.find((e) => e.name === "Full name").ref,
				text: "Grace",
			},
		],
	});
	assert.equal(
		fill2.structuredContent.results[0].ok,
		true,
		JSON.stringify(fill2.structuredContent)
	);
	step("take over refuses the runtime's actions; hand back lets them run");
	await call("end_task", {});

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
