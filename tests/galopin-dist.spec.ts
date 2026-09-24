/**
 * galopin served by the deployment itself: with no session, a machine fetches
 * `{base}/galopin/install.sh`, which downloads the binary and SHA256SUMS from
 * the same origin, verifies the checksum and installs. The binary is built
 * from this checkout's agent/ (the same build the real-machine specs use).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as playwrightRequest } from "playwright/test";
import { test, expect, E2E_APP_URL, E2E_GALOPIN_DIST_DIR } from "./fixtures.ts";
import { agentBinary } from "./machineHarness.ts";

const hostName = `galopin-${process.platform === "darwin" ? "darwin" : "linux"}-${
	process.arch === "arm64" ? "arm64" : "amd64"
}`;

test.beforeAll(() => {
	rmSync(E2E_GALOPIN_DIST_DIR, { recursive: true, force: true });
	mkdirSync(E2E_GALOPIN_DIST_DIR, { recursive: true });
	copyFileSync(agentBinary(), join(E2E_GALOPIN_DIST_DIR, hostName));
	const sum = createHash("sha256")
		.update(readFileSync(join(E2E_GALOPIN_DIST_DIR, hostName)))
		.digest("hex");
	writeFileSync(join(E2E_GALOPIN_DIST_DIR, "SHA256SUMS"), `${sum}  ${hostName}\n`);
	writeFileSync(join(E2E_GALOPIN_DIST_DIR, "REVISION"), "built from Cerea e2e\n");
});

test.afterAll(() => rmSync(E2E_GALOPIN_DIST_DIR, { recursive: true, force: true }));

test("install.sh installs a checksum-verified galopin with no session", async () => {
	// A fresh request context: no cookies, no session, as curl on a new machine.
	const anon = await playwrightRequest.newContext();
	try {
		const script = await anon.get(`${E2E_APP_URL}/galopin/install.sh`, { maxRedirects: 0 });
		expect(script.status()).toBe(200);
		const body = await script.text();
		expect(body).toContain(`origin='${E2E_APP_URL}'`);

		const binary = await anon.get(`${E2E_APP_URL}/galopin/${hostName}`, { maxRedirects: 0 });
		expect(binary.status()).toBe(200);
		expect(binary.headers()["content-disposition"]).toContain(hostName);
		const etag = binary.headers()["etag"];
		expect(etag).toBeTruthy();
		const again = await anon.get(`${E2E_APP_URL}/galopin/${hostName}`, {
			headers: { "if-none-match": etag },
			maxRedirects: 0,
		});
		expect(again.status()).toBe(304);

		for (const bad of ["secret", "..%2FSHA256SUMS", "galopin-windows-amd64", "REVISION"]) {
			const res = await anon.get(`${E2E_APP_URL}/galopin/${bad}`, { maxRedirects: 0 });
			expect(res.status(), bad).toBe(404);
		}

		// Run it for real, with the system's POSIX sh.
		const installDir = mkdtempSync(join(tmpdir(), "galopin-install-"));
		const scriptPath = join(installDir, "install.sh");
		writeFileSync(scriptPath, body);
		try {
			const out = execFileSync("sh", [scriptPath], {
				env: {
					PATH: process.env.PATH ?? "",
					HOME: installDir,
					GALOPIN_INSTALL_DIR: join(installDir, "bin"),
				},
				encoding: "utf8",
			});
			expect(out).toContain("checksum verified");
			expect(out).toContain(`galopin enroll --cerea ${E2E_APP_URL}`);
			const help = execFileSync(join(installDir, "bin", "galopin"), ["--help"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			expect(help.toLowerCase()).toContain("enroll");
		} finally {
			rmSync(installDir, { recursive: true, force: true });
		}
	} finally {
		await anon.dispose();
	}
});

test("a tampered download is refused and nothing is installed", async () => {
	const anon = await playwrightRequest.newContext();
	const sumsPath = join(E2E_GALOPIN_DIST_DIR, "SHA256SUMS");
	const original = readFileSync(sumsPath, "utf8");
	writeFileSync(sumsPath, `${"0".repeat(64)}  ${hostName}\n`);
	const installDir = mkdtempSync(join(tmpdir(), "galopin-install-"));
	try {
		const body = await (await anon.get(`${E2E_APP_URL}/galopin/install.sh`)).text();
		writeFileSync(join(installDir, "install.sh"), body);
		let failed = false;
		try {
			execFileSync("sh", [join(installDir, "install.sh")], {
				env: {
					PATH: process.env.PATH ?? "",
					HOME: installDir,
					GALOPIN_INSTALL_DIR: join(installDir, "bin"),
				},
				stdio: "pipe",
			});
		} catch (err) {
			failed = true;
			expect(String((err as { stderr?: Buffer }).stderr)).toContain("checksum mismatch");
		}
		expect(failed).toBe(true);
		expect(() => readFileSync(join(installDir, "bin", "galopin"))).toThrow();
	} finally {
		writeFileSync(sumsPath, original);
		rmSync(installDir, { recursive: true, force: true });
		await anon.dispose();
	}
});
