/**
 * Mock MCP Apps server (SEP-1865, https://github.com/modelcontextprotocol/ext-apps): tools that
 * link a `ui://` resource through `_meta.ui.resourceUri`, and the resources themselves, served
 * as `text/html;profile=mcp-app`.
 *
 * Stateless Streamable HTTP like `mock-mcp.ts`. Run it by hand with
 *   node --experimental-strip-types tests/mock-apps-mcp.ts      (port 8793, MOCK_APPS_MCP_PORT)
 * and add `http://127.0.0.1:8793/mcp` as a connector (needs MCP_ALLOW_INSECURE_URLS=true).
 *
 * Tools
 * - `show_time`       linked to `ui://mock-apps/time.html`: markup of the official
 *                     `basic-server-vanillajs` example (see CREDIT below) with a small inline bridge.
 * - `show_probe`      linked to `ui://mock-apps/probe.html`: the page that calls `echo_app` back
 *                     through the bridge, posts a message into the chat and tries sandbox escapes.
 * - `echo_app`        `_meta.ui.visibility: ["app"]`: only the page may call it; a model never sees it.
 * - `plain`           no `_meta.ui`: a host without apps (or with the connector's switch off) shows
 *                     only its text result.
 *
 * The probe page writes what happened into `#probe-results` (JSON) and sets
 * `data-done="1"` on `<body>` when every probe has settled. `ok: true` means the page got through:
 * `cookie` is ok whenever reading `document.cookie` does not throw (an opaque origin throws), `origin`
 * whenever `self.origin` is not "null" (a host that serves the page from a sandbox-proxy origin
 * instead of an opaque one must drop that probe from its spec). Every probe that must FAIL under a
 * correct host sandbox is named in `PROBES_MUST_FAIL`. The server counts requests to its
 * `/__control/escape-ping` endpoint, the target of the undeclared-domain fetch, so a spec can
 * assert that no request ever arrived (`escapePings()`).
 *
 * CREDIT: the `time.html` markup (buttons for server time, message, log, open link) is adapted from
 * modelcontextprotocol/ext-apps `examples/basic-server-vanillajs/mcp-app.html`, Apache-2.0 (MIT for
 * older contributions); its bundled TypeScript is replaced here by a dependency-free inline bridge
 * so the fixture needs no build step.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";

export const MOCK_APPS_MCP_PORT = Number(process.env.MOCK_APPS_MCP_PORT ?? 8793);

export const APP_MIME = "text/html;profile=mcp-app";
export const TIME_URI = "ui://mock-apps/time.html";
export const PROBE_URI = "ui://mock-apps/probe.html";
export const BROKEN_URI = "ui://mock-apps/broken.html";

/** Probe names the page reports as `{ ok: false }` when the host's sandbox holds. */
export const PROBES_MUST_FAIL = [
	"cookie",
	"origin",
	"parentDocument",
	"topNavigation",
	"fetchUndeclared",
	"imgExfil",
	"beacon",
	"localStorage",
] as const;

export interface AppsToolCall {
	name: string;
	args: Record<string, unknown>;
	at: number;
}

export interface MockAppsMcp {
	url: string;
	origin: string;
	port: number;
	/** Tool calls the server received (the page's `echo_app` calls included). */
	calls(): AppsToolCall[];
	/** Requests that reached `/__control/escape-ping`: must stay 0 under a correct sandbox. */
	escapePings(): number;
	/** `resources/read` requests served, by URI. */
	reads(): string[];
	reset(): void;
	close(): Promise<void>;
}

/** The inline bridge: JSON-RPC 2.0 over `postMessage`, as the ext-apps `App` class speaks it. */
const BRIDGE = `
const pending = new Map();
let nextId = 1;
const listeners = {};
function send(msg) { window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*"); }
function request(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ id, method, params });
		setTimeout(() => { if (pending.delete(id)) reject(new Error("timeout")); }, 8000);
	});
}
window.addEventListener("message", (event) => {
	const m = event.data;
	if (!m || m.jsonrpc !== "2.0") return;
	if (m.id !== undefined && !m.method && pending.has(m.id)) {
		const p = pending.get(m.id); pending.delete(m.id);
		m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result);
	} else if (m.method && listeners[m.method]) {
		listeners[m.method](m.params);
		if (m.id !== undefined) send({ id: m.id, result: {} });
	} else if (m.method && m.id !== undefined) {
		send({ id: m.id, result: {} });
	}
});
const ready = request("ui/initialize", {
	appInfo: { name: "mock-apps", version: "1.0.0" },
	appCapabilities: {},
	protocolVersion: "2026-01-26",
}).then((r) => { send({ method: "ui/notifications/initialized", params: {} }); return r; });
`;

const TIME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Get Time App</title>
</head>
<body>
  <main class="main">
    <div class="action">
      <p><strong>Server Time:</strong> <code id="server-time">Loading...</code></p>
      <button id="get-time-btn">Get Server Time</button>
    </div>
    <div class="action">
      <textarea id="message-text">This is message text.</textarea>
      <button id="send-message-btn">Send Message</button>
    </div>
    <div class="action">
      <input type="url" id="link-url" value="https://modelcontextprotocol.io/">
      <button id="open-link-btn">Open Link</button>
    </div>
  </main>
  <script>
${BRIDGE}
const timeEl = document.getElementById("server-time");
listeners["ui/notifications/tool-result"] = (r) => {
	timeEl.textContent = (r && r.structuredContent && r.structuredContent.time) || "[ERROR]";
};
document.getElementById("get-time-btn").onclick = async () => {
	try {
		const r = await request("tools/call", { name: "show_time", arguments: {} });
		timeEl.textContent = (r.structuredContent && r.structuredContent.time) || "[ERROR]";
	} catch (e) { timeEl.textContent = "[ERROR]"; }
};
document.getElementById("send-message-btn").onclick = () =>
	request("ui/message", { role: "user", content: [{ type: "text", text: document.getElementById("message-text").value }] }).catch(() => {});
document.getElementById("open-link-btn").onclick = () =>
	request("ui/open-link", { url: document.getElementById("link-url").value }).catch(() => {});
  </script>
</body>
</html>`;

function probeHtml(origin: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Probe app</title></head>
<body>
  <h1 id="title">Probe app</h1>
  <p id="input">waiting for tool input</p>
  <button id="call-tool">Call echo_app</button>
  <button id="call-shared">Call echo_shared</button>
  <button id="send-message">Post message</button>
  <button id="request-fullscreen">Edit</button>
  <button id="request-inline">Done</button>
  <p id="display-mode">display:inline</p>
  <p id="load-marker"></p>
  <p id="container-dims"></p>
  <p id="call-result"></p>
  <pre id="probe-results">{}</pre>
  <script>
${BRIDGE}
const results = {};
const out = document.getElementById("probe-results");
const record = (name, ok, detail) => { results[name] = { ok, detail: String(detail ?? "") }; out.textContent = JSON.stringify(results); };
listeners["ui/notifications/tool-input"] = (p) => {
	document.getElementById("input").textContent = "input:" + JSON.stringify(p && p.arguments);
};
listeners["ui/notifications/tool-result"] = (p) => {
	document.getElementById("title").dataset.result = JSON.stringify(p && p.content);
};
document.getElementById("call-tool").onclick = async () => {
	const el = document.getElementById("call-result");
	try {
		const r = await request("tools/call", { name: "echo_app", arguments: { text: "from-app" } });
		el.textContent = "result:" + ((r.content && r.content[0] && r.content[0].text) || "");
	} catch (e) { el.textContent = "error:" + e.message; }
};
document.getElementById("call-shared").onclick = async () => {
	const el = document.getElementById("call-result");
	try {
		const r = await request("tools/call", { name: "echo_shared", arguments: { text: "from-app" } });
		el.textContent = "result:" + ((r.content && r.content[0] && r.content[0].text) || "");
	} catch (e) { el.textContent = "error:" + e.message; }
};
document.getElementById("send-message").onclick = () =>
	request("ui/message", { role: "user", content: [{ type: "text", text: "hello from the app" }] }).catch(() => {});
// Display modes: the page asks, and follows whatever the host reports. The marker proves the
// document was not reloaded across a switch (a reload would write a new one).
ready.then((r) => { document.getElementById("container-dims").textContent = "dims:" + JSON.stringify(r && r.hostContext && r.hostContext.containerDimensions); });
listeners["ui/notifications/host-context-changed"] = (p) => { if (p && p.displayMode) showMode(p.displayMode); if (p && p.containerDimensions) document.getElementById("container-dims").textContent = "dims:" + JSON.stringify(p.containerDimensions); };
document.getElementById("load-marker").textContent = "marker:" + Math.random().toString(36).slice(2);
const showMode = (mode) => { document.getElementById("display-mode").textContent = "display:" + mode; };
document.getElementById("request-fullscreen").onclick = () =>
	request("ui/request-display-mode", { mode: "fullscreen" }).then((r) => showMode(r.mode), () => {});
document.getElementById("request-inline").onclick = () =>
	request("ui/request-display-mode", { mode: "inline" }).then((r) => showMode(r.mode), () => {});

async function probes() {
	try { const c = document.cookie; record("cookie", true, "read:" + c.length); } catch (e) { record("cookie", false, e.name); }
	record("origin", self.origin !== "null", self.origin);
	try { const d = window.parent.document.body.innerHTML; record("parentDocument", true, d.length); } catch (e) { record("parentDocument", false, e.name); }
	try { window.top.location.href = "about:blank#escaped"; record("topNavigation", true, "navigated"); } catch (e) { record("topNavigation", false, e.name); }
	try { localStorage.setItem("x", "1"); record("localStorage", true, "set"); } catch (e) { record("localStorage", false, e.name); }
	try {
		await fetch(${JSON.stringify(origin)} + "/__control/escape-ping", { mode: "no-cors" });
		record("fetchUndeclared", true, "fetched");
	} catch (e) { record("fetchUndeclared", false, e.name); }
	await new Promise((resolve) => {
		const img = new Image();
		img.onload = () => { record("imgExfil", true, "loaded"); resolve(); };
		img.onerror = () => { record("imgExfil", false, "blocked"); resolve(); };
		setTimeout(resolve, 3000);
		img.src = ${JSON.stringify(origin)} + "/__control/escape-ping?via=img";
	});
	try { record("beacon", navigator.sendBeacon(${JSON.stringify(origin)} + "/__control/escape-ping?via=beacon", "x"), "queued"); } catch (e) { record("beacon", false, e.name); }
	await new Promise((resolve) => setTimeout(resolve, 500));
	document.body.dataset.done = "1";
}
ready.then(probes, probes);
  </script>
</body>
</html>`;
}

/** A page that fails: it throws on load, and tries a fetch its policy forbids. */
function brokenHtml(origin: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Broken app</title></head>
<body>
  <p id="state">broken page</p>
  <script>
fetch(${JSON.stringify(origin)} + "/__control/escape-ping?via=broken").catch(() => {});
setTimeout(() => { throw new Error("boom-on-load"); }, 50);
  </script>
</body>
</html>`;
}

function buildServer(
	record: (call: AppsToolCall) => void,
	noteRead: (uri: string) => void,
	origin: string
): McpServer {
	const server = new McpServer(
		{ name: "mock-apps-mcp", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } }
	);
	const none = fromJsonSchema<Record<string, never>>({ type: "object", properties: {} });

	server.registerTool(
		"show_time",
		{
			description: "Shows the server time in an interactive app.",
			inputSchema: none,
			_meta: { ui: { resourceUri: TIME_URI }, "ui/resourceUri": TIME_URI },
		},
		() => {
			record({ name: "show_time", args: {}, at: Date.now() });
			const time = new Date().toISOString();
			return { content: [{ type: "text" as const, text: time }], structuredContent: { time } };
		}
	);

	server.registerTool(
		"show_probe",
		{
			description: "Shows the probe app: tool call back, message, and sandbox escape attempts.",
			inputSchema: fromJsonSchema<{ label?: string }>({
				type: "object",
				properties: { label: { type: "string" } },
			}),
			_meta: { ui: { resourceUri: PROBE_URI }, "ui/resourceUri": PROBE_URI },
		},
		({ label }) => {
			record({ name: "show_probe", args: { label }, at: Date.now() });
			return { content: [{ type: "text" as const, text: `probe shown: ${label ?? ""}` }] };
		}
	);

	server.registerTool(
		"echo_app",
		{
			description: "Echoes text; only the app page calls it.",
			inputSchema: fromJsonSchema<{ text: string }>({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			}),
			_meta: { ui: { resourceUri: PROBE_URI, visibility: ["app"] } },
		},
		({ text }) => {
			record({ name: "echo_app", args: { text }, at: Date.now() });
			return { content: [{ type: "text" as const, text: `app-echo:${text}` }] };
		}
	);

	server.registerTool(
		"echo_shared",
		{
			description: "Echoes text; the model can call it too, so a page's call asks first.",
			inputSchema: fromJsonSchema<{ text: string }>({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			}),
			_meta: { ui: { resourceUri: PROBE_URI } },
		},
		({ text }) => {
			record({ name: "echo_shared", args: { text }, at: Date.now() });
			return { content: [{ type: "text" as const, text: `app-echo:${text}` }] };
		}
	);

	server.registerTool(
		"show_broken",
		{
			description: "Shows a page that throws on load.",
			inputSchema: none,
			_meta: { ui: { resourceUri: BROKEN_URI } },
		},
		() => {
			record({ name: "show_broken", args: {}, at: Date.now() });
			return { content: [{ type: "text" as const, text: "broken shown" }] };
		}
	);

	server.registerTool("plain", { description: "A tool with no app.", inputSchema: none }, () => {
		record({ name: "plain", args: {}, at: Date.now() });
		return { content: [{ type: "text" as const, text: "plain result" }] };
	});

	server.registerResource(
		"time",
		TIME_URI,
		{ mimeType: APP_MIME, _meta: { ui: { csp: {} } } },
		() => {
			noteRead(TIME_URI);
			return { contents: [{ uri: TIME_URI, mimeType: APP_MIME, text: TIME_HTML }] };
		}
	);
	server.registerResource("probe", PROBE_URI, { mimeType: APP_MIME }, () => {
		noteRead(PROBE_URI);
		return {
			contents: [
				{
					uri: PROBE_URI,
					mimeType: APP_MIME,
					text: probeHtml(origin),
					// No connectDomains: the fetch to this server's own origin is undeclared.
					_meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
				},
			],
		};
	});

	server.registerResource("broken", BROKEN_URI, { mimeType: APP_MIME }, () => {
		noteRead(BROKEN_URI);
		return {
			contents: [
				{
					uri: BROKEN_URI,
					mimeType: APP_MIME,
					text: brokenHtml(origin),
					_meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
				},
			],
		};
	});

	return server;
}

export async function startMockAppsMcp(port: number = MOCK_APPS_MCP_PORT): Promise<MockAppsMcp> {
	const recorded: AppsToolCall[] = [];
	const reads: string[] = [];
	let pings = 0;
	let origin = `http://127.0.0.1:${port}`;

	const httpServer: Server = createServer((req, res) => {
		void handle(req, res).catch((err) => {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(err) }));
			} else res.end();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", origin);
		const json = (body: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/health") return json({ ok: true });
		if (url.pathname === "/__control/escape-ping") {
			pings++;
			// A 1x1 GIF, so an <img> that gets through reports `load`.
			res.writeHead(200, { "content-type": "image/gif", "access-control-allow-origin": "*" });
			res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
			return;
		}
		if (url.pathname === "/__control/calls") return json(recorded);
		if (url.pathname === "/__control/pings") return json({ pings });
		if (url.pathname === "/__control/reads") return json(reads);
		if (url.pathname === "/__control/reset" && req.method === "POST") {
			recorded.length = 0;
			reads.length = 0;
			pings = 0;
			return json({ ok: true });
		}
		if (url.pathname === "/mcp") {
			const server = buildServer(
				(c) => recorded.push(c),
				(u) => reads.push(u),
				origin
			);
			const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res);
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found", path: url.pathname }));
	}

	await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
	const actualPort = (httpServer.address() as AddressInfo).port;
	origin = `http://127.0.0.1:${actualPort}`;

	return {
		url: `${origin}/mcp`,
		origin,
		port: actualPort,
		calls: () => [...recorded],
		escapePings: () => pings,
		reads: () => [...reads],
		reset: () => {
			recorded.length = 0;
			reads.length = 0;
			pings = 0;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				httpServer.close((err) => (err ? reject(err) : resolve()));
				httpServer.closeAllConnections();
			}),
	};
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	startMockAppsMcp().then((mock) => {
		console.log(`[mock-apps-mcp] listening on ${mock.url}`);
	});
}
