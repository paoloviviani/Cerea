/**
 * The socket proxy as a server, against a fake Docker. The point is request smuggling: a request
 * the proxy has checked must never be followed by bytes Docker parses as a second, unchecked one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { PolicyConfig } from "../src/socket-proxy/policy.ts";
import { createProxy } from "../src/socket-proxy/server.ts";

const FULL = (c: string) => c.repeat(64);
const EXEC = FULL("e");
const managed = { "cerea.sandbox": "1", "cerea.sandbox.instance": "unit" };
const cfg: PolicyConfig = { instance: "unit", runtimes: ["runc"], images: ["img"] };

/** A fake Docker on a unix socket. It records every byte it receives, per connection. */
function fakeDocker(socketPath: string, startReply: "101" | "200") {
	const received: string[] = [];
	const conns = new Set<net.Socket>();
	const server = net.createServer({ allowHalfOpen: true }, (c) => {
		conns.add(c);
		c.on("close", () => conns.delete(c));
		const slot = received.push("") - 1;
		let answered = false;
		const json = (status: string, body: unknown) => {
			const b = JSON.stringify(body);
			c.write(
				`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n${b}`
			);
		};
		c.on("data", (d) => {
			received[slot] += d.toString("latin1");
			const text = received[slot];
			if (answered || !text.includes("\r\n\r\n")) return;
			const line = text.split("\r\n")[0];
			answered = true;
			if (
				line.startsWith(`GET /containers/${FULL("a")}/json`) ||
				line.startsWith("GET /containers/mine/json")
			) {
				json("200 OK", { Id: FULL("a"), Config: { Labels: managed } });
			} else if (line.startsWith(`GET /exec/${EXEC}/json`)) {
				json("200 OK", { ContainerID: FULL("a") });
			} else if (line.startsWith(`POST /exec/${EXEC}/start`)) {
				if (startReply === "101") {
					c.write(
						"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
					);
				} else {
					c.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
				}
			} else {
				json("404 Not Found", { message: "no such" });
			}
		});
	});
	return new Promise<{ server: net.Server; received: string[]; conns: Set<net.Socket> }>(
		(resolve) => server.listen(socketPath, () => resolve({ server, received, conns }))
	);
}

/** Sends raw bytes to the proxy and collects what comes back until it closes (or 1.5 s). */
function rawExchange(port: number, bytes: string, then?: (s: net.Socket) => void): Promise<string> {
	return new Promise((resolve) => {
		const s = net.connect(port, "127.0.0.1", () => s.write(bytes));
		let out = "";
		s.on("data", (d) => {
			out += d.toString("latin1");
			then?.(s);
		});
		const done = () => {
			clearTimeout(timer);
			resolve(out);
		};
		s.on("close", done);
		s.on("error", done);
		const timer = setTimeout(() => {
			s.destroy();
			done();
		}, 1500);
	});
}

const body = (o: unknown) => JSON.stringify(o);
const startRequest = (execId: string, payload: string, extra = "") =>
	`POST /exec/${execId}/start HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${payload.length}\r\n\r\n${payload}${extra}`;
const SMUGGLED = "GET /info HTTP/1.1\r\nHost: docker\r\n\r\n";

describe("socket proxy: request smuggling", () => {
	let dir: string;
	const closers: (() => void)[] = [];
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "sbx-proxy-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => {
		for (const c of closers.splice(0)) c();
	});

	async function setup(startReply: "101" | "200") {
		const sock = join(dir, `d-${Math.random().toString(36).slice(2)}.sock`);
		const fake = await fakeDocker(sock, startReply);
		const proxy = createProxy({ socketPath: sock }, cfg);
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		closers.push(() => {
			proxy.closeAllConnections();
			proxy.close();
			for (const c of fake.conns) c.destroy();
			fake.server.close();
		});
		return { port: (proxy.address() as net.AddressInfo).port, fake };
	}
	const sawInfo = (received: string[]) => received.some((r) => r.includes("GET /info"));
	const responses = (out: string) => (out.match(/HTTP\/1\.1 /g) ?? []).length;

	it("refuses a detached start, and a request smuggled behind it is never answered or forwarded", async () => {
		const { port, fake } = await setup("200");
		const out = await rawExchange(
			port,
			startRequest(EXEC, body({ Detach: true, Tty: false }), SMUGGLED)
		);
		assert.match(out, /^HTTP\/1\.1 (400|403)/);
		assert.equal(responses(out), 1);
		assert.equal(sawInfo(fake.received), false);
	});

	it("refuses bytes in the same packet as the start request", async () => {
		const { port, fake } = await setup("101");
		const out = await rawExchange(
			port,
			startRequest(EXEC, body({ Detach: false, Tty: false }), SMUGGLED)
		);
		assert.match(out, /^HTTP\/1\.1 400/);
		assert.equal(responses(out), 1);
		assert.equal(sawInfo(fake.received), false);
		assert.equal(
			fake.received.some((r) => r.includes("POST /exec/")),
			false,
			"the start itself was not forwarded"
		);
	});

	it("answers an error before the hijack once, and forwards nothing behind it", async () => {
		const { port, fake } = await setup("101");
		const missing = FULL("9");
		const out = await rawExchange(
			port,
			startRequest(missing, body({ Detach: false, Tty: false })) + SMUGGLED
		);
		assert.match(out, /^HTTP\/1\.1 400|^HTTP\/1\.1 404/);
		assert.equal(responses(out), 1);
		assert.equal(sawInfo(fake.received), false);
	});

	it("when Docker does not hijack, relays its answer and closes: a later request is not forwarded", async () => {
		const { port, fake } = await setup("200");
		const first = startRequest(EXEC, body({ Detach: false, Tty: false }));
		const out = await rawExchange(port, first, (s) => {
			// Once Docker's (non-101) answer has been relayed, try to ride the connection.
			setTimeout(() => s.write(SMUGGLED), 100);
		});
		assert.match(out, /^HTTP\/1\.1 200/);
		assert.equal(responses(out), 1);
		assert.equal(sawInfo(fake.received), false);
	});

	it("after a real hijack the client's bytes are the process's stdin, and nothing else", async () => {
		const { port, fake } = await setup("101");
		const out = await rawExchange(
			port,
			startRequest(EXEC, body({ Detach: false, Tty: false })),
			(s) => {
				setTimeout(() => s.end("stdin-bytes"), 100);
			}
		);
		assert.match(out, /^HTTP\/1\.1 101/);
		const start = fake.received.find((r) => r.includes(`POST /exec/${EXEC}/start`)) ?? "";
		assert.ok(start.includes("stdin-bytes"));
	});

	it("refuses chunked bodies and a missing or odd Content-Length on an upgrade", async () => {
		const { port, fake } = await setup("101");
		const payload = body({ Detach: false, Tty: false });
		const chunked = `POST /exec/${EXEC}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nTransfer-Encoding: chunked\r\n\r\n${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
		assert.match(await rawExchange(port, chunked), /^HTTP\/1\.1 400/);
		const none = `POST /exec/${EXEC}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`;
		assert.match(await rawExchange(port, none), /^HTTP\/1\.1 400/);
		assert.equal(
			fake.received.some((r) => r.includes("POST /exec/")),
			false
		);
	});

	it("refuses an exec start that is not an upgrade", async () => {
		const { port, fake } = await setup("101");
		const payload = body({ Detach: false, Tty: false });
		const plain = `POST /exec/${EXEC}/start HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`;
		assert.match(await rawExchange(port, plain), /^HTTP\/1\.1 400/);
		assert.equal(
			fake.received.some((r) => r.includes("POST /exec/")),
			false
		);
	});

	it("sends each ordinary request on its own upstream connection", async () => {
		const { port, fake } = await setup("101");
		const get = "GET /containers/mine/json HTTP/1.1\r\nHost: x\r\n\r\n";
		const out = await rawExchange(port, get + get);
		assert.equal(responses(out) >= 1, true);
		// Each forwarded request is alone on its connection, and says `Connection: close`.
		for (const r of fake.received.filter((x) => x.includes("GET /containers/"))) {
			assert.equal((r.match(/HTTP\/1\.1\r\n/g) ?? []).length, 1);
			assert.match(r, /connection: close/i);
		}
	});

	describe("duplicate keys and the forwarded bytes", () => {
		const post = (path: string, payload: string) =>
			`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`;
		const valid =
			'"HostConfig":{"Runtime":"runc","Memory":1048576,"MemorySwap":1048576,"PidsLimit":10,"NanoCpus":1000000000}';
		const reached = (received: string[], what: string) => received.some((r) => r.includes(what));

		it("refuses a repeated HostConfig (Go would merge the two), forwarding nothing", async () => {
			const { port, fake } = await setup("101");
			const dup = `{"Image":"img",${valid.replace(/^/, "")},"HostConfig":{"Privileged":true,"Binds":["/:/host"]}}`;
			const out = await rawExchange(port, post("/containers/create?name=cerea-sbx-x", dup));
			assert.match(out, /^HTTP\/1\.1 400/);
			assert.match(out, /repeats a key/);
			assert.equal(reached(fake.received, "POST /containers/create"), false);
		});

		it("refuses a repeated key at depth, and an escaped spelling of a repeated key", async () => {
			const { port, fake } = await setup("101");
			const nested = '{"Cmd":["id"],"Env":[],"Cmd":["sh"]}';
			assert.match(
				await rawExchange(port, post("/containers/mine/exec", nested)),
				/^HTTP\/1\.1 400/
			);
			const escaped = '{"Cmd":["id"],"C\\u006dd":["sh"]}';
			assert.match(
				await rawExchange(port, post("/containers/mine/exec", escaped)),
				/^HTTP\/1\.1 400/
			);
			const deep = '{"Cmd":["id"],"User":"65534","x":{"a":{"b":1,"b":2}}}';
			assert.match(await rawExchange(port, post("/containers/mine/exec", deep)), /^HTTP\/1\.1 400/);
			assert.equal(reached(fake.received, "POST /containers/mine/exec"), false);
		});

		it("refuses a repeated key on the upgrade path too", async () => {
			const { port, fake } = await setup("101");
			const out = await rawExchange(
				port,
				startRequest(EXEC, '{"Detach":true,"Detach":false,"Tty":false}')
			);
			assert.match(out, /^HTTP\/1\.1 400/);
			assert.equal(reached(fake.received, "POST /exec/"), false);
		});

		it("forwards the canonical JSON of what it checked, with its own Content-Length", async () => {
			const { port, fake } = await setup("101");
			await rawExchange(
				port,
				post("/containers/mine/exec", '{ "Cmd" : [ "id" ] ,\n "Tty" : false }')
			);
			const sent =
				fake.received.find((r) => r.startsWith(`POST /containers/${FULL("a")}/exec`)) ?? "";
			const canonical = '{"Cmd":["id"],"Tty":false}';
			assert.ok(sent.endsWith(`\r\n\r\n${canonical}`), JSON.stringify(sent));
			assert.match(sent, new RegExp(`content-length: ${canonical.length}\\r\\n`, "i"));
			// and on the upgrade path
			await rawExchange(port, startRequest(EXEC, '{ "Detach" : false,  "Tty" : false }'), (s) =>
				setTimeout(() => s.end(), 50)
			);
			const start = fake.received.find((r) => r.includes(`POST /exec/${EXEC}/start`)) ?? "";
			const c2 = '{"Detach":false,"Tty":false}';
			assert.ok(start.includes(`Content-Length: ${c2.length}\r\n`));
			assert.ok(start.includes(`\r\n\r\n${c2}`));
		});
	});
});
