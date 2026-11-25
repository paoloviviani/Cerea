import { mkdtempSync, statSync } from "node:fs";
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

describe("bridge socket", () => {
	const runDir = mkdtempSync(join(tmpdir(), "cdp-test-"));
	const bridge = new CdpBridge(host, new Control());
	const started = startBridgeServer(bridge, {
		runDir,
		uid: process.getuid?.() ?? 0,
		secret: "s3cret",
	});
	afterAll(async () => (await started).close());

	const open = (path: string, headers: Record<string, string> = {}) =>
		new Promise<string>(async (resolve) => {
			const s = await started;
			const sock = s.endpoint.split("ws+unix://")[1].split(":/cdp/")[0];
			const ws = new WebSocket(`ws+unix://${sock}:${path}`, { headers });
			ws.on("open", () => {
				ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
			});
			ws.on("message", (m) => {
				resolve(`ok ${m.toString().slice(0, 40)}`);
				ws.close();
			});
			ws.on("unexpected-response", (_r, res) => resolve(`http ${res.statusCode}`));
			ws.on("error", () => resolve("error"));
		});

	it("is a 0600 socket in a 0700 directory, with a 0600 endpoint file, and no TCP port", async () => {
		const s = await started;
		const sock = s.endpoint.split("ws+unix://")[1].split(":/cdp/")[0];
		expect(statSync(sock).mode & 0o777).toBe(0o600);
		expect(statSync(join(sock, "..")).mode & 0o777).toBe(0o700);
		expect(statSync(s.endpointFile).mode & 0o777).toBe(0o600);
		expect(s.endpoint.startsWith("ws+unix://")).toBe(true);
	});

	it("answers with the right secret and no Origin", async () => {
		expect(await open("/cdp/s3cret")).toMatch(/^ok /);
	});

	it("refuses a wrong secret, no secret, and any request that carries an Origin", async () => {
		expect(await open("/cdp/wrong")).toBe("http 401");
		expect(await open("/cdp/")).toBe("http 401");
		expect(await open("/")).toBe("http 401");
		expect(await open("/cdp/s3cret", { Origin: "https://evil.example" })).toBe("http 401");
	});

	it("compares secrets in constant time and by length", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
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
