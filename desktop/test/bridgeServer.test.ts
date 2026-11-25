import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { CdpBridge } from "../src/main/cdpBridge.ts";
import { Control } from "../src/main/control.ts";
import { safeEqual, startBridgeServer } from "../src/main/bridgeServer.ts";

const host = {
	targets: () => [],
	create: async () => {
		throw new Error("no");
	},
	close() {},
	activate() {},
	onTargetCreated: () => () => {},
	onTargetDestroyed: () => () => {},
	setDownloadDir() {},
	onDownload: () => () => {},
	bounds: () => ({ left: 0, top: 0, width: 1, height: 1 }),
};

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

async function twoProfiles(
	active: () => string | null,
	control?: { current(): "agent" | "user"; onChange(cb: () => void): () => void }
) {
	const runDir = mkdtempSync(join(tmpdir(), "cdp-test-"));
	const dirA = mkdtempSync(join(tmpdir(), "galA-"));
	const dirB = mkdtempSync(join(tmpdir(), "galB-"));
	let connected = 0;
	const bridge = { connect: (t: { close(): void }) => (connected++, t.close()), disconnect() {} };
	const server = await startBridgeServer(bridge as never, {
		runDir,
		uid: process.getuid?.() ?? 0,
		active,
		control,
	});
	const fileA = server.addProfile(A, dirA, "secretA");
	const fileB = server.addProfile(B, dirB, "secretB");
	return { server, fileA, fileB, dirA, dirB, connected: () => connected };
}

describe("bridge socket", () => {
	let active: string | null = A;
	const rigP = twoProfiles(() => active);
	afterAll(async () => (await rigP).server.close());

	const open = (path: string, headers: Record<string, string> = {}) =>
		new Promise<string>(async (resolve) => {
			const r = await rigP;
			const ws = new WebSocket(`ws+unix://${r.server.socket}:${path}`, { headers });
			ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })));
			ws.on("close", () => resolve("closed after open"));
			ws.on("unexpected-response", (_q, res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve(`http ${res.statusCode} ${body}`.trim()));
			});
			ws.on("error", () => resolve("error"));
		});

	it("is a 0600 socket, with one 0600 endpoint file in each profile's own galopin directory, and no TCP port", async () => {
		const r = await rigP;
		expect(statSync(r.server.socket).mode & 0o777).toBe(0o600);
		expect(statSync(join(r.server.socket, "..")).mode & 0o777).toBe(0o700);
		for (const f of [r.fileA, r.fileB]) expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(r.fileA).toBe(join(r.dirA, "cdp-endpoint"));
		expect(r.fileB).toBe(join(r.dirB, "cdp-endpoint"));
		expect(readFileSync(r.fileA, "utf8")).toContain("/cdp/secretA");
		expect(readFileSync(r.fileB, "utf8")).toContain("/cdp/secretB");
		expect(readFileSync(r.fileA, "utf8").startsWith("ws+unix://")).toBe(true);
	});

	it("serves the active profile's secret and no Origin", async () => {
		expect(await open("/cdp/secretA")).toMatch(/^closed after open|^ok/);
	});

	it("refuses an inactive profile's secret, saying so, on CDP", async () => {
		active = A;
		expect(await open("/cdp/secretB")).toBe("http 403 This browser belongs to another profile.");
		active = B; // after a switch the roles swap
		expect(await open("/cdp/secretA")).toBe("http 403 This browser belongs to another profile.");
		expect(await open("/cdp/secretB")).toMatch(/^closed after open|^ok/);
		active = A;
	});

	it("refuses a wrong secret, no secret, and any request that carries an Origin", async () => {
		expect(await open("/cdp/wrong")).toBe("http 401");
		expect(await open("/cdp/")).toBe("http 401");
		expect(await open("/")).toBe("http 401");
		expect(await open("/cdp/secretA", { Origin: "https://evil.example" })).toBe("http 401");
		expect(await open("/cdp/secretB", { Origin: "https://evil.example" })).toBe("http 401");
	});

	it("compares secrets in constant time and by length", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
	});

	it("forgets a removed profile's secret and endpoint file", async () => {
		const r = await rigP;
		r.server.removeProfile(B);
		expect(r.server.endpointFile(B)).toBeUndefined();
		expect(await open("/cdp/secretB")).toBe("http 401");
	});
});

describe("the bridge directory", () => {
	it("refuses a symlink, another user's directory and an open one it cannot fix", async () => {
		const { ensurePrivateDir } = await import("../src/main/bridgeServer.ts");
		const { mkdtempSync, symlinkSync, mkdirSync, chmodSync, statSync } = await import("node:fs");
		const base = mkdtempSync(join(tmpdir(), "ensure-"));
		const uid = process.getuid?.() ?? 0;
		const real = join(base, "real");
		mkdirSync(real);
		const link = join(base, "link");
		symlinkSync(real, link);
		expect(() => ensurePrivateDir(link, uid)).toThrow(/plain directory/);
		expect(() => ensurePrivateDir(real, uid + 1)).toThrow(/another user/);
		chmodSync(real, 0o777);
		ensurePrivateDir(real, uid); // tightened, because it is ours
		expect(statSync(real).mode & 0o777).toBe(0o700);
		const fresh = join(base, "a", "b");
		ensurePrivateDir(fresh, uid);
		expect(statSync(fresh).mode & 0o777).toBe(0o700);
	});
});

describe("the control stream", () => {
	it("pushes who is driving to the active profile only, with the same secret rules as the socket", async () => {
		const http = await import("node:http");
		let mode: "agent" | "user" = "agent";
		const cbs = new Set<() => void>();
		let active: string | null = A;
		const r = await twoProfiles(() => active, {
			current: () => mode,
			onChange: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
		});
		const get = (path: string, headers: Record<string, string> = {}) =>
			new Promise<{ status?: number; body: string; req: import("node:http").ClientRequest }>(
				(resolve) => {
					let body = "";
					const req = http.request({ socketPath: r.server.socket, path, headers }, (res) => {
						res.setEncoding("utf8");
						res.on("data", (c: string) => (body += c));
						setTimeout(
							() =>
								resolve({
									status: res.statusCode,
									get body() {
										return body;
									},
									req,
								} as never),
							100
						);
					});
					req.end();
				}
			);
		try {
			expect((await get("/ctl/wrong")).status).toBe(404);
			expect((await get("/ctl/secretA", { Origin: "https://evil.example" })).status).toBe(404);
			// an inactive profile's secret is refused on /ctl too
			const other = await get("/ctl/secretB");
			expect(other.status).toBe(403);
			expect(other.body).toBe("This browser belongs to another profile.");
			const ok = await get("/ctl/secretA");
			expect(ok.status).toBe(200);
			expect(ok.body).toContain('data: {"mode":"agent"}');
			mode = "user";
			for (const cb of cbs) cb();
			await new Promise((res) => setTimeout(res, 50));
			expect(ok.body).toContain('data: {"mode":"user"}');
			// a switch ends the old profile's stream
			let ended = false;
			ok.req.on("close", () => (ended = true));
			active = B;
			r.server.setActive(B);
			await new Promise((res) => setTimeout(res, 50));
			expect(ended).toBe(true);
			ok.req.destroy();
		} finally {
			await r.server.close();
		}
	});
});
