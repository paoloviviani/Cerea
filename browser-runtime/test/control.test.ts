import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { controlResultSchema } from "../src/contract.ts";
import { parseEndpoint } from "../src/controlWatch.ts";
import { createToolHandler } from "../src/server.ts";
import { BrowserSession } from "../src/session.ts";

/** A stand-in for the desktop app's /ctl stream. */
async function fakeApp() {
	const dir = await mkdtemp(join(tmpdir(), "cerea-ctl-"));
	const sock = join(dir, "c.sock");
	const secret = "s3cret_token";
	let mode: "agent" | "user" = "user";
	const streams = new Set<http.ServerResponse>();
	const server = http.createServer((req, res) => {
		if (req.url !== `/ctl/${secret}`) {
			res.statusCode = 404;
			return void res.end();
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ mode })}\n\n`);
		streams.add(res);
		res.on("close", () => streams.delete(res));
	});
	await new Promise<void>((r) => server.listen(sock, r));
	const file = join(dir, "endpoint");
	await writeFile(file, `ws+unix://${sock}:/cdp/${secret}\n`);
	return {
		file,
		set(next: "agent" | "user") {
			mode = next;
			for (const s of streams) s.write(`data: ${JSON.stringify({ mode })}\n\n`);
		},
		async close() {
			for (const s of streams) s.end();
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			await rm(dir, { recursive: true, force: true });
		},
		secret,
		sock,
	};
}

describe("control: who is driving", () => {
	let app: Awaited<ReturnType<typeof fakeApp>>;
	let session: BrowserSession;
	let call: ReturnType<typeof createToolHandler>;
	before(async () => {
		app = await fakeApp();
		session = new BrowserSession({
			profileDir: tmpdir(),
			headless: true,
			stateDir: tmpdir(),
			connectFile: app.file,
			controlWaitMs: 300,
		});
		call = createToolHandler(session);
	});
	after(async () => {
		await session.close();
		await app.close();
	});

	it("parses the endpoint file the desktop app writes", () => {
		assert.deepEqual(parseEndpoint(`ws+unix:///run/u/c.sock:/cdp/abc_DEF-1`), {
			socketPath: "/run/u/c.sock",
			secret: "abc_DEF-1",
		});
		assert.equal(parseEndpoint("ws://127.0.0.1:9222/devtools"), undefined);
	});

	it("reports the user as driving, and holds every other tool instead of failing it", async () => {
		const state = await call("control", {});
		assert.equal(state.isError, undefined);
		assert.equal(controlResultSchema.parse(state.structuredContent).state, "user");
		// held for the (short, test) wait limit, then an error the loop can read, never a browser call
		const held = await call("snapshot", {});
		assert.equal(held.isError, true);
		assert.match(JSON.stringify(held.content), /user is driving/);
	});

	it("control with wait returns when the user hands back, and held tools then run", async () => {
		setTimeout(() => app.set("agent"), 60);
		const t0 = Date.now();
		const state = await call("control", { wait: true });
		assert.equal(controlResultSchema.parse(state.structuredContent).state, "agent");
		assert.ok(Date.now() - t0 < 280, "returned at hand-back, not at the limit");
		// a held call is released by the hand-back
		app.set("user");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(session.userDriving, true);
		setTimeout(() => app.set("agent"), 60);
		assert.equal(await session.waitForAgent(300), true);
	});

	it("takes the user to be not driving when the app goes away", async () => {
		app.set("user");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(session.userDriving, true);
		await app.close();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(session.userDriving, false);
	});
});

describe("control: a browser nobody can take over", () => {
	it("always answers agent and holds nothing", async () => {
		const session = new BrowserSession({ profileDir: tmpdir(), headless: true });
		const call = createToolHandler(session);
		const r = await call("control", { wait: true });
		assert.equal(controlResultSchema.parse(r.structuredContent).state, "agent");
		await session.close();
	});
});
