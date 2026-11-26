import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	findRuntime,
	fromCereaPage,
	parsePageMessage,
	RUNTIME_TOOLS,
	WindowBrowser,
	windowGrantKey,
	type SpawnFn,
} from "../src/main/windowBrowser.ts";

const WID = "w".repeat(32);
const announce = (cookie = "hf-chat", windowId = WID) =>
	JSON.stringify({ jsonrpc: "2.0", method: "cerea/window", params: { windowId, cookie } });
const call = (id: string, name: string, args: unknown = {}) =>
	JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("parsePageMessage", () => {
	it("accepts a call of each runtime tool, and nothing else", () => {
		for (const name of RUNTIME_TOOLS) {
			expect(parsePageMessage(call("a1", name, { x: 1 }))).toEqual({
				kind: "call",
				id: "a1",
				name,
				args: { x: 1 },
			});
		}
		for (const name of ["evaluate", "__proto__", "Snapshot", "", "snapshot ", "act;rm"]) {
			expect(parsePageMessage(call("a1", name)).kind).toBe("bad");
		}
	});
	it("refuses other methods, other shapes, and a missing id", () => {
		const bad = (m: unknown) => parsePageMessage(typeof m === "string" ? m : JSON.stringify(m));
		expect(bad({ jsonrpc: "2.0", id: "a", method: "initialize", params: {} }).kind).toBe("bad");
		expect(bad({ jsonrpc: "2.0", id: "a", method: "tools/list" }).kind).toBe("bad");
		expect(bad({ jsonrpc: "1.0", id: "a", method: "tools/call" }).kind).toBe("bad");
		expect(bad({ jsonrpc: "2.0", method: "tools/call", params: { name: "snapshot" } }).kind).toBe(
			"bad"
		);
		expect(
			bad({ jsonrpc: "2.0", id: "a b", method: "tools/call", params: { name: "diff" } }).kind
		).toBe("bad");
		expect(
			bad({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "act", arguments: [] } })
				.kind
		).toBe("bad");
		expect(bad("[]").kind).toBe("bad");
		expect(bad("not json").kind).toBe("bad");
		expect(parsePageMessage(42).kind).toBe("bad");
		expect(parsePageMessage({}).kind).toBe("bad");
	});
	it("caps the size of a request", () => {
		const huge = call("a1", "act", { pad: "x".repeat(300 * 1024) });
		expect(parsePageMessage(huge)).toMatchObject({ kind: "bad", why: "too large" });
	});
	it("takes the window announcement only in its exact form", () => {
		expect(parsePageMessage(announce())).toEqual({
			kind: "window",
			windowId: WID,
			cookie: "hf-chat",
		});
		expect(parsePageMessage(announce("bad name")).kind).toBe("bad");
		expect(parsePageMessage(announce("../x")).kind).toBe("bad");
		expect(parsePageMessage(announce("hf-chat", "short")).kind).toBe("bad");
		expect(parsePageMessage(announce("hf-chat", "a/b".repeat(10))).kind).toBe("bad");
		expect(
			parsePageMessage(
				JSON.stringify({ jsonrpc: "2.0", method: "cerea/key", params: { key: "x" } })
			).kind
		).toBe("bad");
	});
	it("derives the grant key as the server does (one shared test vector)", () => {
		expect(windowGrantKey("session-secret-1", WID).toString("base64url")).toBe(
			"wCHTHLSWwMEgM93UlYwsthZyQDhe8mALmKvR11ee_I8"
		);
	});
	it("lists the tools the runtime lists", () => {
		const src = readFileSync(
			join(__dirname, "..", "..", "browser-runtime", "src", "contract.ts"),
			"utf8"
		);
		const block = /RUNTIME_TOOLS = \[([^\]]*)\]/.exec(src)![1];
		const names = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
		expect([...RUNTIME_TOOLS]).toEqual(names);
	});
});

describe("fromCereaPage", () => {
	const frame = { url: "https://cerea.example/chat/c/1" };
	const view = { webContents: { mainFrame: frame } };
	const ok = { view, origin: "https://cerea.example", profileActive: true };
	const e = { sender: view.webContents, senderFrame: frame };
	it("accepts the Cerea view's main frame on the profile's origin", () => {
		expect(fromCereaPage(e, ok)).toBe(true);
	});
	it("refuses another web contents (the panel, the local UI), a subframe, another origin, an inactive profile", () => {
		expect(fromCereaPage({ ...e, sender: {} }, ok)).toBe(false);
		expect(fromCereaPage({ ...e, senderFrame: { url: frame.url } }, ok)).toBe(false);
		const nav = { webContents: { mainFrame: { url: "https://idp.example/login" } } };
		expect(
			fromCereaPage(
				{ sender: nav.webContents, senderFrame: nav.webContents.mainFrame },
				{ ...ok, view: nav }
			)
		).toBe(false);
		expect(fromCereaPage({ ...e, senderFrame: null }, ok)).toBe(false);
		expect(fromCereaPage(e, { ...ok, profileActive: false })).toBe(false);
		expect(fromCereaPage(e, { ...ok, view: undefined })).toBe(false);
		expect(fromCereaPage(e, { ...ok, origin: "" })).toBe(false);
		// a look-alike origin
		const evil = { webContents: { mainFrame: { url: "https://cerea.example.evil.test/" } } };
		expect(
			fromCereaPage(
				{ sender: evil.webContents, senderFrame: evil.webContents.mainFrame },
				{ ...ok, view: evil }
			)
		).toBe(false);
	});
});

describe("findRuntime", () => {
	const res = mkdtempSync(join(tmpdir(), "wb-res-"));
	it("a packaged app runs only what it ships", () => {
		expect(findRuntime({ resources: res, devRoot: "/nope", packaged: true })).toBeUndefined();
		mkdirSync(join(res, "node", "bin"), { recursive: true });
		writeFileSync(join(res, "node", "bin", "node"), "");
		writeFileSync(join(res, "node", ".node-sha256"), "abc\n24.0.0\n");
		mkdirSync(join(res, "browser-runtime"), { recursive: true });
		writeFileSync(join(res, "browser-runtime", "cerea-browser.mjs"), "");
		expect(findRuntime({ resources: res, devRoot: "/nope", packaged: true })).toEqual({
			node: join(res, "node", "bin", "node"),
			script: join(res, "browser-runtime", "cerea-browser.mjs"),
		});
	});
	it("a development run falls back to the source and the Node on PATH, never an environment override when packaged", () => {
		const exists = (p: string) => p.endsWith("main.ts") || p === "/usr/bin/node";
		expect(findRuntime({ devRoot: "/r/desktop", env: { PATH: "/usr/bin" }, exists })?.script).toBe(
			"/r/desktop/../browser-runtime/src/main.ts".replace("/desktop/..", "")
		);
		expect(
			findRuntime({
				resources: "/none",
				devRoot: "/r/desktop",
				packaged: true,
				env: { CEREA_DESKTOP_NODE: "/evil/node" },
				exists: () => true,
			})
		).toBeUndefined();
	});
});

/** A fake runtime: answers MCP over its pipes, like browser-runtime does. */
function fakeSpawn(opts: { onCall?: (name: string, args: unknown) => unknown } = {}) {
	const spawned: { command: string; args: string[]; child: FakeChild }[] = [];
	class FakeChild extends EventEmitter {
		stdin = new PassThrough();
		stdout = new PassThrough();
		stderr = new PassThrough();
		exitCode: number | null = null;
		killed: string[] = [];
		constructor() {
			super();
			let buf = "";
			this.stdin.on("data", (d: Buffer) => {
				buf += d.toString();
				for (;;) {
					const at = buf.indexOf("\n");
					if (at < 0) break;
					const msg = JSON.parse(buf.slice(0, at));
					buf = buf.slice(at + 1);
					if (msg.id === undefined) continue;
					const result =
						msg.method === "initialize"
							? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
							: opts.onCall
								? opts.onCall(msg.params.name, msg.params.arguments)
								: {
										content: [{ type: "text", text: "{}" }],
										structuredContent: { ok: true, tool: msg.params.name },
										leaked: "never crosses",
									};
					this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
				}
			});
		}
		kill(sig: string) {
			this.killed.push(sig);
			this.exitCode = 0;
			this.emit("exit", 0);
			return true;
		}
	}
	const spawnFn: SpawnFn = (command, args) => {
		const child = new FakeChild();
		spawned.push({ command, args, child });
		return child as never;
	};
	return { spawnFn, spawned };
}

function make(over: Partial<ConstructorParameters<typeof WindowBrowser>[0]> = {}) {
	const dir = join(mkdtempSync(join(tmpdir(), "wb-dir-")), "p1");
	const sent: string[] = [];
	const fake = fakeSpawn();
	const onTask = vi.fn();
	const wb = new WindowBrowser({
		dir,
		endpointFile: () => "/run/endpoint",
		runtime: { node: "/node", script: "/rt/cerea-browser.mjs" },
		readCookie: async (name) => (name === "hf-chat" ? "session-secret-1" : undefined),
		postToPage: (j) => sent.push(j),
		onTask,
		log: () => {},
		spawnFn: fake.spawnFn,
		...over,
	});
	const next = async () => {
		const before = sent.length;
		for (let i = 0; i < 200 && sent.length === before; i++)
			await new Promise((r) => setTimeout(r, 5));
		return JSON.parse(sent[sent.length - 1]);
	};
	return { wb, dir, sent, fake, onTask, next };
}

describe("WindowBrowser", () => {
	it("starts one runtime for its profile, on the bridge's endpoint, and stops it", async () => {
		const { wb, fake } = make();
		expect(wb.available).toBe(true);
		wb.start();
		await vi.waitFor(() => expect(wb.running).toBe(true));
		expect(fake.spawned).toHaveLength(1);
		const { command, args } = fake.spawned[0];
		expect(command).toBe("/node");
		expect(args).toContain("--connect-file");
		expect(args[args.indexOf("--connect-file") + 1]).toBe("/run/endpoint");
		expect(args).toContain("--key-file");
		expect(args).not.toContain("--profile");
		await wb.dispose();
		expect(fake.spawned[0].child.killed).toEqual(["SIGTERM"]);
		expect(wb.available).toBe(false);
	});
	it("is not available without a shipped runtime or a bridge", () => {
		expect(make({ runtime: undefined }).wb.available).toBe(false);
		expect(make({ endpointFile: () => undefined }).wb.available).toBe(false);
	});
	it("relays a call and returns only the result's own fields", async () => {
		const { wb, next, onTask } = make();
		wb.start();
		wb.handleFromPage(call("c1", "snapshot"));
		const answer = await next();
		expect(answer).toEqual({
			jsonrpc: "2.0",
			id: "c1",
			result: {
				content: [{ type: "text", text: "{}" }],
				structuredContent: { ok: true, tool: "snapshot" },
			},
		});
		expect(onTask).toHaveBeenCalledTimes(1);
		await wb.dispose();
	});
	it("never forwards a method or tool that is not allowed, and answers the id with an error", async () => {
		const { wb, fake, next } = make();
		wb.start();
		await vi.waitFor(() => expect(wb.running).toBe(true));
		const writes: string[] = [];
		fake.spawned[0].child.stdin.on("data", (d: Buffer) => writes.push(d.toString()));
		const first = next();
		wb.handleFromPage(call("c2", "evaluate", { expression: "1" }));
		const answer = await first;
		expect(answer.error.message).toMatch(/tool not allowed/);
		const second = next();
		wb.handleFromPage(
			JSON.stringify({ jsonrpc: "2.0", id: "c3", method: "initialize", params: {} })
		);
		expect((await second).error.message).toMatch(/method not allowed/);
		expect(writes.join("")).toBe("");
		await wb.dispose();
	});
	it("derives the grant key from the session cookie, writes it 0600, and removes it when it stops", async () => {
		const { wb, dir } = make();
		wb.start();
		wb.handleFromPage(announce());
		const file = join(dir, "approval-key");
		await vi.waitFor(() => expect(existsSync(file)).toBe(true));
		expect(readFileSync(file, "utf8").trim()).toBe(
			windowGrantKey("session-secret-1", WID).toString("base64url")
		);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		await wb.dispose();
		expect(existsSync(file)).toBe(false);
	});
	it("writes no key when the cookie is not there: nothing commit-class could be approved", async () => {
		const { wb, dir, next } = make();
		wb.start();
		wb.handleFromPage(announce("other-cookie"));
		wb.handleFromPage(call("c9", "snapshot"));
		await next();
		expect(existsSync(join(dir, "approval-key"))).toBe(false);
		await wb.dispose();
	});
	it("removes a stale key when it starts", async () => {
		const { wb, dir } = make();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, "approval-key"), "old");
		wb.start();
		expect(existsSync(join(dir, "approval-key"))).toBe(false);
		await wb.dispose();
	});
	it("limits how fast a page may call", async () => {
		let t = 1000;
		const { wb, sent } = make({ now: () => t });
		wb.start();
		for (let i = 0; i < 60; i++) wb.handleFromPage(call(`r${i}`, "diff"));
		await new Promise((r) => setTimeout(r, 100));
		const refused = sent
			.map((s) => JSON.parse(s))
			.filter((m) => m.error?.message.includes("Too many"));
		expect(refused.length).toBeGreaterThanOrEqual(15);
		t += 11_000;
		await wb.dispose();
	});
	it("tells the page when the runtime cannot answer, and stops restarting a runtime that keeps failing", async () => {
		const sent: string[] = [];
		let spawns = 0;
		const spawnFn: SpawnFn = () => {
			spawns += 1;
			const c = new EventEmitter() as never as {
				stdin: PassThrough;
				stdout: PassThrough;
				stderr: PassThrough;
				kill: () => boolean;
				on: EventEmitter["on"];
				emit: EventEmitter["emit"];
			};
			c.stdin = new PassThrough();
			c.stdout = new PassThrough();
			c.stderr = new PassThrough();
			c.kill = () => true;
			queueMicrotask(() => c.emit("exit", 1));
			return c as never;
		};
		const { wb } = make({ spawnFn, postToPage: (j) => sent.push(j) });
		for (let i = 0; i < 6; i++) {
			wb.handleFromPage(call(`f${i}`, "snapshot"));
			await new Promise((r) => setTimeout(r, 30));
		}
		const errors = sent.map((s) => JSON.parse(s)).filter((m) => m.error);
		expect(errors.length).toBe(6);
		expect(spawns).toBeLessThanOrEqual(3);
		expect(errors.at(-1).error.message).toMatch(/keeps stopping/);
	});
});
