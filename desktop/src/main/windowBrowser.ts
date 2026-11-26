/**
 * The window browser (ADR 0122): the app runs the browser runtime itself, so the chat in this
 * window can drive the app's own embedded panel with no galopin and no paired computer.
 *
 * One `WindowBrowser` per profile, made when that profile's Cerea view loads and disposed when it
 * goes (a switch, a removal, quitting). It runs `cerea-browser` (the same runtime galopin runs)
 * as a child process of the app's own Node, connected to this profile's CDP bridge through the
 * endpoint file the bridge already writes (`--connect-file`), and speaks MCP to it over stdio.
 *
 * The page talks to it through the narrow preload API (`preload/cerea.ts`), one JSON string at a
 * time. Everything from the page is untrusted, whatever the page is: a message is parsed here, only
 * `tools/call` for the runtime's own tool names and the window announcement are relayed, sizes and rates are
 * capped, and the sender is checked in `fromCereaPage` on every message. This module has no
 * Electron imports: `main.ts` wires it, and the unit tests drive it with a fake child.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ensurePrivateDir, writeEndpointFile } from "./bridgeServer.ts";
import { bundledNode } from "./nodeRuntime.ts";
import { RateLimit } from "./rateLimit.ts";

/** The runtime's own tools (browser-runtime `RUNTIME_TOOLS`, kept equal by a test). The only methods relayed. */
export const RUNTIME_TOOLS = [
	"snapshot",
	"diff",
	"act",
	"extract",
	"screenshot",
	"download",
	"tabs",
	"resume",
	"open",
	"control",
	"end_task",
] as const;

/** A request from the page: a call's arguments, never a download or a screenshot. */
export const MAX_REQUEST_CHARS = 256 * 1024;
/** An answer to the page: bounded by what the server's socket takes (24 MiB); a little under. */
export const MAX_RESPONSE_CHARS = 20 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
/** A task makes a call every second or two at the most. */
const CALLS_PER_WINDOW = 40;
const RATE_WINDOW_MS = 10_000;
const CALL_TIMEOUT_MS = 200_000;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type PageMessage =
	| { kind: "call"; id: string; name: string; args: Record<string, unknown> }
	| { kind: "window"; windowId: string; cookie: string };
export type PageParse = PageMessage | { kind: "bad"; id?: string; why: string };

/** What a page may ask for. Anything else is "bad" and never reaches the runtime. */
export function parsePageMessage(raw: unknown): PageParse {
	if (typeof raw !== "string") return { kind: "bad", why: "not text" };
	if (raw.length > MAX_REQUEST_CHARS) return { kind: "bad", why: "too large" };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { kind: "bad", why: "not JSON" };
	}
	if (typeof json !== "object" || json === null || Array.isArray(json))
		return { kind: "bad", why: "not an object" };
	const m = json as Record<string, unknown>;
	if (m.jsonrpc !== "2.0") return { kind: "bad", why: "not JSON-RPC 2.0" };
	const id = typeof m.id === "string" && ID_PATTERN.test(m.id) ? m.id : undefined;
	const params = m.params;
	if (m.method === "cerea/window") {
		const { windowId, cookie } = (params ?? {}) as { windowId?: unknown; cookie?: unknown };
		if (
			typeof windowId !== "string" ||
			!WINDOW_ID_PATTERN.test(windowId) ||
			typeof cookie !== "string" ||
			!COOKIE_NAME_PATTERN.test(cookie)
		)
			return { kind: "bad", why: "bad window" };
		return { kind: "window", windowId, cookie };
	}
	if (m.method !== "tools/call") return { kind: "bad", id, why: "method not allowed" };
	if (!id) return { kind: "bad", why: "a call needs an id" };
	if (typeof params !== "object" || params === null || Array.isArray(params))
		return { kind: "bad", id, why: "bad params" };
	const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
	if (typeof name !== "string" || !(RUNTIME_TOOLS as readonly string[]).includes(name))
		return { kind: "bad", id, why: "tool not allowed" };
	if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
		return { kind: "bad", id, why: "bad arguments" };
	return { kind: "call", id, name, args: (args as Record<string, unknown> | undefined) ?? {} };
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/**
 * The key that signs a window's approval grants, the same one the server derives
 * (`windowGrantKey` in the server's `browser/windowRegistry.ts`; a test keeps them equal): from the
 * session cookie's value, which is HttpOnly and so readable here and not by the page, and the
 * window id.
 */
export function windowGrantKey(sessionSecret: string, windowId: string): Buffer {
	return createHmac("sha256", sessionSecret).update(`cerea-window-grant-key|${windowId}`).digest();
}

/**
 * Whether an IPC message comes from the page that may drive the browser: the Cerea view of the
 * active profile, its main frame (not a subframe, not the panel, not the local UI), and the page's
 * address on that profile's server origin. Checked on every message, not once.
 */
export function fromCereaPage(
	e: { sender: unknown; senderFrame?: { url: string } | null },
	ctx: {
		view?: { webContents: { mainFrame: unknown } };
		origin: string;
		profileActive: boolean;
	}
): boolean {
	if (!ctx.view || !ctx.origin || !ctx.profileActive) return false;
	const wc = ctx.view.webContents;
	return (
		e.sender === wc &&
		!!e.senderFrame &&
		e.senderFrame === wc.mainFrame &&
		originOf(e.senderFrame.url) === ctx.origin
	);
}

/** Where the runtime and the Node that runs it are, or undefined when this build has none. */
export interface RuntimeLocation {
	node: string;
	script: string;
}

export function findRuntime(opts: {
	resources?: string;
	devRoot: string;
	packaged?: boolean;
	env?: NodeJS.ProcessEnv;
	exists?: (p: string) => boolean;
}): RuntimeLocation | undefined {
	const env = opts.env ?? process.env;
	const exists = opts.exists ?? existsSync;
	const bundled = bundledNode(opts.resources);
	if (opts.packaged) {
		const script = opts.resources && join(opts.resources, "browser-runtime", "cerea-browser.mjs");
		return bundled && script && exists(script)
			? { node: join(bundled.dir, "bin", "node"), script }
			: undefined;
	}
	const staged = join(opts.devRoot, "resources", "browser-runtime", "cerea-browser.mjs");
	const source = join(opts.devRoot, "..", "browser-runtime", "src", "main.ts");
	const script = exists(staged) ? staged : exists(source) ? source : undefined;
	if (!script) return undefined;
	// A development run has no shipped Node: the one on PATH (the runtime needs Node 22.18 or later).
	const node =
		bundled?.dir && exists(join(bundled.dir, "bin", "node"))
			? join(bundled.dir, "bin", "node")
			: (env.CEREA_DESKTOP_NODE ?? findOnPath("node", env, exists));
	return node ? { node, script } : undefined;
}

function findOnPath(
	bin: string,
	env: NodeJS.ProcessEnv,
	exists: (p: string) => boolean
): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir && exists(join(dir, bin))) return join(dir, bin);
	}
	return undefined;
}

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args) =>
	spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });

interface Waiting {
	resolve(v: unknown): void;
	reject(e: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** MCP over a child's stdio: one JSON message per line, both ways. */
class McpStdio {
	private nextId = 1;
	private buffer = "";
	private waiting = new Map<number, Waiting>();
	closed = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly onStderr: (line: string) => void
	) {
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onData(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const l of chunk.split(/\r?\n/)) if (l) this.onStderr(l);
		});
		const end = (why: string) => {
			if (this.closed) return;
			this.closed = true;
			for (const w of this.waiting.values()) {
				clearTimeout(w.timer);
				w.reject(new Error(why));
			}
			this.waiting.clear();
		};
		child.on("exit", (code) => end(`The browser runtime stopped (exit ${code}).`));
		child.on("error", (err) => end(`The browser runtime could not start: ${err.message}`));
		child.stdin?.on("error", () => end("The browser runtime closed its input."));
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		// A runtime that never ends a line must not grow the buffer without bound.
		if (this.buffer.length > MAX_RESPONSE_CHARS + 1024 * 1024) {
			this.buffer = "";
			return;
		}
		for (;;) {
			const at = this.buffer.indexOf("\n");
			if (at < 0) return;
			const line = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at + 1);
			if (!line.trim()) continue;
			let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const w = this.waiting.get(msg.id);
			if (!w) continue;
			this.waiting.delete(msg.id);
			clearTimeout(w.timer);
			if (msg.error)
				w.reject(new Error(String(msg.error.message ?? "The runtime reported an error.")));
			else w.resolve(msg.result);
		}
	}

	private write(message: unknown): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new Error("The browser runtime is not running."));
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error("The browser runtime did not answer in time."));
			}, timeoutMs);
			this.waiting.set(id, { resolve, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.closed) this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
	}
}

export interface WindowBrowserDeps {
	/** Where this profile's key and spent approvals are kept (private, outside galopin's directory). */
	dir: string;
	/** This profile's CDP endpoint file (`bridgeServer.endpointFile`), when its bridge is up. */
	endpointFile: () => string | undefined;
	runtime: RuntimeLocation | undefined;
	/** The value of the profile's session cookie `name` on the server's origin (HttpOnly: main can read it). */
	readCookie: (name: string) => Promise<string | undefined>;
	/** One JSON string to the page (the preload's `onMessage`). */
	postToPage: (json: string) => void;
	/** A task is using the browser: the app shows the panel (the `agent-active` event). */
	onTask: () => void;
	log: (line: string) => void;
	spawnFn?: SpawnFn;
	uid?: number;
	now?: () => number;
}

export class WindowBrowser {
	private mcp?: McpStdio;
	private child?: ChildProcess;
	private starting?: Promise<McpStdio>;
	private disposed = false;
	private inFlight = 0;
	private readonly rate: RateLimit;
	private failures: number[] = [];
	/** The key being written for the page's window: calls wait for it. */
	private keyReady: Promise<void> = Promise.resolve();
	private lastTaskPush = Number.NEGATIVE_INFINITY;

	constructor(private readonly deps: WindowBrowserDeps) {
		this.rate = new RateLimit(CALLS_PER_WINDOW, RATE_WINDOW_MS, deps.now);
	}

	private keyFile(): string {
		return join(this.deps.dir, "approval-key");
	}

	/** Whether the app can run a browser for the page: a runtime is shipped and the bridge is up. */
	get available(): boolean {
		return !this.disposed && !!this.deps.runtime && !!this.deps.endpointFile();
	}

	get running(): boolean {
		return !!this.mcp && !this.mcp.closed;
	}

	/** Starts the runtime (with no approval key: nothing commit-class runs until the server sends one). */
	start(): void {
		if (!this.available) return;
		try {
			ensurePrivateDir(this.deps.dir, this.deps.uid ?? process.getuid?.() ?? 0);
			rmSync(this.keyFile(), { force: true });
		} catch (err) {
			this.deps.log(`[window browser] ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		void this.ensure().catch((err) =>
			this.deps.log(`[window browser] ${err instanceof Error ? err.message : String(err)}`)
		);
	}

	private ensure(): Promise<McpStdio> {
		if (this.disposed) return Promise.reject(new Error("The browser is closed."));
		if (this.mcp && !this.mcp.closed) return Promise.resolve(this.mcp);
		if (this.starting) return this.starting;
		const t = (this.deps.now ?? Date.now)();
		this.failures = this.failures.filter((x) => t - x < 30_000);
		if (this.failures.length >= 3)
			return Promise.reject(new Error("The browser runtime keeps stopping; it is not restarted."));
		const endpoint = this.deps.endpointFile();
		const rt = this.deps.runtime;
		if (!rt || !endpoint) return Promise.reject(new Error("The app's browser is not ready."));
		this.starting = (async () => {
			mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
			const child = (this.deps.spawnFn ?? defaultSpawn)(rt.node, [
				rt.script,
				"--connect-file",
				endpoint,
				"--key-file",
				this.keyFile(),
				"--state-dir",
				join(this.deps.dir, "state"),
			]);
			this.child = child;
			const mcp = new McpStdio(child, (l) => this.deps.log(`[window browser] ${l}`));
			child.on("exit", () => {
				if (this.mcp === mcp) this.mcp = undefined;
				if (this.child === child) this.child = undefined;
				if (!this.disposed) this.failures.push((this.deps.now ?? Date.now)());
			});
			try {
				await mcp.request(
					"initialize",
					{
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "cerea-desktop", version: "1" },
					},
					30_000
				);
				mcp.notify("notifications/initialized");
			} catch (err) {
				child.kill("SIGKILL");
				throw err;
			}
			if (this.disposed) {
				child.kill("SIGKILL");
				throw new Error("The browser is closed.");
			}
			this.mcp = mcp;
			return mcp;
		})().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/** One message from the page (already known to come from the right page: `fromCereaPage`). */
	handleFromPage(raw: unknown): void {
		if (this.disposed) return;
		const msg = parsePageMessage(raw);
		if (msg.kind === "bad") {
			if (msg.id) this.reply(msg.id, undefined, `Refused: ${msg.why}.`);
			return;
		}
		if (msg.kind === "window") {
			this.keyReady = this.storeKey(msg.windowId, msg.cookie);
			return;
		}
		if (!this.rate.take()) return this.reply(msg.id, undefined, "Too many requests; slow down.");
		if (this.inFlight >= MAX_IN_FLIGHT)
			return this.reply(msg.id, undefined, "Too many requests at once.");
		this.inFlight += 1;
		this.pushTask();
		void this.keyReady
			.then(() => this.ensure())
			.then((mcp) => mcp.request("tools/call", { name: msg.name, arguments: msg.args }))
			.then(
				(result) => this.replyResult(msg.id, result),
				(err: unknown) =>
					this.reply(msg.id, undefined, err instanceof Error ? err.message : String(err))
			)
			.finally(() => {
				this.inFlight -= 1;
			});
	}

	/**
	 * Derives this window's grant key from the session cookie and writes it where the runtime reads
	 * it. Without a cookie no key is written, and the runtime accepts no approval.
	 */
	private async storeKey(windowId: string, cookie: string): Promise<void> {
		try {
			rmSync(this.keyFile(), { force: true });
			const secret = await this.deps.readCookie(cookie);
			if (!secret || this.disposed) return;
			ensurePrivateDir(this.deps.dir, this.deps.uid ?? process.getuid?.() ?? 0);
			writeEndpointFile(
				this.keyFile(),
				`${windowGrantKey(secret, windowId).toString("base64url")}\n`
			);
		} catch (err) {
			this.deps.log(`[window browser] the key was not stored: ${String(err)}`);
		}
	}

	/** At most one `onTask` in two seconds: the panel opens when work starts, not on every call. */
	private pushTask(): void {
		const t = (this.deps.now ?? Date.now)();
		if (t - this.lastTaskPush < 2000) return;
		this.lastTaskPush = t;
		this.deps.onTask();
	}

	private replyResult(id: string, result: unknown): void {
		const r = (typeof result === "object" && result !== null ? result : {}) as {
			content?: unknown;
			structuredContent?: unknown;
			isError?: unknown;
		};
		// Only these fields cross, whatever else the runtime put in the message.
		const body = {
			jsonrpc: "2.0",
			id,
			result: {
				content: Array.isArray(r.content) ? r.content : [],
				...(r.structuredContent && typeof r.structuredContent === "object"
					? { structuredContent: r.structuredContent }
					: {}),
				...(r.isError === true ? { isError: true } : {}),
			},
		};
		const text = JSON.stringify(body);
		if (text.length > MAX_RESPONSE_CHARS) {
			return this.reply(id, undefined, "The result was too large to send to the chat.");
		}
		this.deps.postToPage(text);
	}

	private reply(id: string, _result: undefined, message: string): void {
		this.deps.postToPage(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
	}

	/** Stops the runtime and forgets the key: the page is gone or another profile is active. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			rmSync(this.keyFile(), { force: true });
		} catch {
			// the directory may be gone with its profile
		}
		this.mcp = undefined;
		const child = this.child;
		this.child = undefined;
		await new Promise<void>((resolve) => {
			if (!child || child.exitCode !== null) return resolve();
			const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
			child.once("exit", () => {
				clearTimeout(kill);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}
}
