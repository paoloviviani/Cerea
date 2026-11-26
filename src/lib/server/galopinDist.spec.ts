import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const env = vi.hoisted(() => ({ GALOPIN_DIST_DIR: "", PUBLIC_ORIGIN: "" }));
vi.mock("$lib/server/config", () => ({ config: env }));

const { GOOSE_SHA256, GOOSE_VERSION } = await import("$lib/gooseVersion");
const { VIBE_LOCK_SHA256, VIBE_VERSION } = await import("$lib/vibeVersion");
const { OPENCODE_SHA256 } = await import("$lib/opencodeVersion");
const { OPENCODE_VERSION } = await import("$lib/codeEnrollCommand");
const { serveGalopinFile, renderInstallScript, galopinOrigin, parseSha256Sums, GALOPIN_BINARIES } =
	await import("./galopinDist");

let dir: string;
const sums: Record<string, string> = {};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "galopin-dist-"));
	for (const name of GALOPIN_BINARIES) {
		const body = `binary ${name}`;
		writeFileSync(join(dir, name), body);
		sums[name] = createHash("sha256").update(body).digest("hex");
	}
	writeFileSync(
		join(dir, "SHA256SUMS"),
		Object.entries(sums)
			.map(([name, sum]) => `${sum}  ${name}`)
			.join("\n") + "\n"
	);
	writeFileSync(join(dir, "REVISION"), "built from Cerea abc123\n");
	// A file in the directory that must never be served.
	writeFileSync(join(dir, "secret.txt"), "nope");
	env.GALOPIN_DIST_DIR = dir;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const serve = (name: string, ifNoneMatch?: string) =>
	serveGalopinFile(name, { origin: "https://stack.example.org/chat", ifNoneMatch });

async function text(body: BodyInit | null): Promise<string> {
	return new Response(body).text();
}

describe("the public galopin files", () => {
	it("serves each of the four binaries as a download with its checksum as the ETag", async () => {
		for (const name of GALOPIN_BINARIES) {
			const res = await serve(name);
			expect(res.status).toBe(200);
			expect(res.headers["content-type"]).toBe("application/octet-stream");
			expect(res.headers["content-disposition"]).toBe(`attachment; filename="${name}"`);
			expect(res.headers.etag).toBe(`"${sums[name]}"`);
			expect(res.headers["cache-control"]).toContain("no-cache");
			expect(await text(res.body)).toBe(`binary ${name}`);
		}
	});

	it("answers a matching If-None-Match with 304 and no body", async () => {
		const res = await serve("galopin-linux-amd64", `"${sums["galopin-linux-amd64"]}"`);
		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
	});

	it("serves SHA256SUMS and version as text", async () => {
		const sumsRes = await serve("SHA256SUMS");
		expect(sumsRes.status).toBe(200);
		expect(sumsRes.headers["content-type"]).toMatch(/^text\/plain/);
		expect(parseSha256Sums(await text(sumsRes.body)).size).toBe(4);
		const version = await serve("version");
		expect(await text(version.body)).toBe("built from Cerea abc123\n");
	});

	it("404s everything off the allowlist: other files, traversal, encodings, empty", async () => {
		for (const name of [
			"secret.txt",
			"REVISION",
			"galopin-windows-amd64",
			"..",
			"../secret.txt",
			"..%2fsecret.txt",
			"%2e%2e",
			"galopin-linux-amd64/",
			"galopin-linux-amd64%00",
			"",
		]) {
			const res = await serve(name);
			expect(res.status, name).toBe(404);
		}
	});

	it("reports the version the served binaries carry, else this Cerea's own", async () => {
		const { servedGalopinVersion } = await import("./galopinDist");
		const saved = env.GALOPIN_DIST_DIR;
		const home = mkdtempSync(join(tmpdir(), "galopin-ver-"));
		env.GALOPIN_DIST_DIR = home;
		const { APP_VERSION } = await import("$lib/utils/appVersion");
		expect(await servedGalopinVersion()).toBe(APP_VERSION);
		writeFileSync(join(home, "GALOPIN_VERSION"), "9.8.7\n");
		expect(await servedGalopinVersion()).toBe("9.8.7");
		writeFileSync(join(home, "GALOPIN_VERSION"), "garbage\n");
		expect(await servedGalopinVersion()).toBe(APP_VERSION);
		env.GALOPIN_DIST_DIR = saved;
		rmSync(home, { recursive: true, force: true });
	});

	it("404s with a short note when the image carries no dist", async () => {
		const saved = env.GALOPIN_DIST_DIR;
		env.GALOPIN_DIST_DIR = join(dir, "missing");
		const res = await serve("galopin-linux-amd64");
		expect(res.status).toBe(404);
		expect(await text(res.body)).toMatch(/not available/);
		env.GALOPIN_DIST_DIR = saved;
	});
});

describe("install.sh", () => {
	it("bakes in this deployment's origin and base, and prints the pairing dialog's commands", async () => {
		const res = await serve("install.sh");
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^text\/x-shellscript/);
		const script = await text(res.body);
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain("origin='https://stack.example.org/chat'");
		expect(script).toContain('fetch "$origin/galopin/$name"');
		expect(script).toContain("Cerea shows the exact command for your account");
		expect(script).toContain("checksum mismatch");
	});

	it("installs the pinned goose, checksum-verified, only with --engine goose", () => {
		const script = renderInstallScript("https://stack.example.org/chat");
		expect(script).toContain('if [ "$engine" = goose ]; then');
		expect(script).toContain(`releases/download/v${GOOSE_VERSION}/$archive`);
		expect(script).toContain("checksum mismatch for $archive");
		for (const [archive, sum] of Object.entries(GOOSE_SHA256)) {
			expect(script).toContain(`${archive}) want=${sum} ;;`);
		}
		// into galopin's own directory: never over a goose the user installed themselves
		expect(script).toContain('install_bin "$tmp/goose-x/goose" "$dir/galopin-goose/goose"');
		expect(script).not.toContain('"$dir/goose"');
		expect(script).toContain("--engine) [ $# -ge 2 ]");
		expect(renderInstallScript("https://s.example", { enrollReady: true })).toContain(
			"galopin enroll --cerea %s%s"
		);
	});

	it("installs the pinned Mistral Vibe from a hash lock with uv, only with --engine vibe", () => {
		const script = renderInstallScript("https://stack.example.org/chat", { enrollReady: true });
		expect(script).toContain('if [ "$engine" = vibe ] && [ -n "$dovibe" ]; then');
		// the lock is fetched from this deployment and must match the sha256 baked in here
		expect(script).toContain('"$origin/galopin/vibe-requirements.txt"');
		expect(script).toContain(`[ "$got" = "${VIBE_LOCK_SHA256}" ]`);
		expect(VIBE_LOCK_SHA256).toMatch(/^[0-9a-f]{64}$/);
		// every package by hash, wheels only (no build step runs), no config of the user's
		expect(script).toContain("--require-hashes --no-deps --only-binary :all:");
		expect(script).toContain("uv --no-config venv");
		expect(script).toContain(`= "${VIBE_VERSION}" ]`);
		// galopin's own directory: never over a Vibe the user installed themselves
		expect(script).toContain('"$dir/galopin-vibe/venv"');
		expect(script).toContain(" --engine vibe");
		expect(script).toContain(`vibe_pinned=${VIBE_VERSION}`);
		expect(script).toContain('if [ "$engine" = vibe ]; then upgrade_vibe; fi');
		expect(script).not.toMatch(/@[A-Z0-9_]+@/);
		const syntax = spawnSync("sh", ["-n"], { input: script });
		expect(syntax.status, syntax.stderr.toString()).toBe(0);
		// without uv the installer says what to do, and installs nothing
		const home = mkdtempSync(join(tmpdir(), "galopin-novibe-"));
		try {
			const run = spawnSync("sh", ["-s", "--", "--engine", "vibe"], {
				input: script,
				env: {
					PATH: "/nonexistent",
					HOME: home,
					TMPDIR: home,
					GALOPIN_INSTALL_DIR: join(home, "bin"),
				},
				encoding: "utf8",
			});
			expect(run.status).not.toBe(0);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("installs the pinned opencode, checksum-verified, only with --with-opencode", () => {
		const script = renderInstallScript("https://stack.example.org/chat");
		expect(script).toContain('if [ "$engine" = opencode ] && [ -n "$withopencode" ]; then');
		expect(script).toContain(`releases/download/v${OPENCODE_VERSION}/$archive`);
		expect(script).toContain("checksum mismatch for $archive");
		for (const [archive, sum] of Object.entries(OPENCODE_SHA256)) {
			expect(script).toContain(`${archive}) want=${sum} ;;`);
		}
		expect(script).toContain("--with-opencode) withopencode=1; shift ;;");
		// the variants opencode's own installer picks, and a run check before success
		expect(script).toContain('archive="opencode-$os-$ocarch$baseline$musl$ext"');
		expect(script).toContain("grep -qwi avx2 /proc/cpuinfo");
		expect(script).toContain("/etc/alpine-release");
		expect(script).toContain('"$tmp/oc-x/opencode" --version');
		expect(script).not.toContain("opencode.ai");
	});

	it("has an --upgrade mode (also GALOPIN_UPGRADE=1) that stays POSIX sh and bash-free", () => {
		const script = renderInstallScript("https://stack.example.org/chat", { enrollReady: true });
		for (const piece of [
			"--upgrade) upgrade=1",
			"--stop) stopfg=1",
			"--creds) ",
			"GALOPIN_UPGRADE:-",
			"nothing to upgrade, run the normal install",
			"galopin.prev",
			"galopin.old",
			"trap 'exit 129' HUP",
			"systemd-run --user --collect",
			"GALOPIN_TERMINAL",
			"could not list processes; stop galopin first",
			"pre-upgrade-",
			"opencode.db-wal",
			"galopin browser setup",
			"Enrollment and settings kept; backup in",
			"To roll back",
			"docker pull ghcr.io/",
			"launchctl",
			`oc_pinned=${OPENCODE_VERSION}`,
			`goose_pinned=${GOOSE_VERSION}`,
		]) {
			expect(script).toContain(piece);
		}
		// the whole installer is one function called last, so a cut-short download does nothing
		expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
		expect(script).toMatch(/\nmain\(\) \{\n/);
		// every placeholder of galopinUpgrade.sh was filled, and its comments are not shipped
		expect(script).not.toMatch(/@[A-Z0-9_]+@/);
		expect(script).not.toContain("shellcheck");
		// the user's own process is matched by fields, never by a bare `pgrep -f`
		expect(script).not.toMatch(/pgrep|pkill|killall/);
		expect(script).not.toMatch(/\[\[ |<\(|pipefail/);
		const syntax = spawnSync("sh", ["-n"], { input: script });
		expect(syntax.status, syntax.stderr.toString()).toBe(0);
		// an unknown option and a missing enrollment are refused before anything is touched
		const home = mkdtempSync(join(tmpdir(), "galopin-nohome-"));
		try {
			const run = spawnSync("sh", ["-s", "--", "--upgrade"], {
				input: script,
				env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
				encoding: "utf8",
			});
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("nothing to upgrade, run the normal install");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("prints the complete enroll commands, or none and a pointer", () => {
		const ready = renderInstallScript("https://stack.example.org/chat", { enrollReady: true });
		expect(ready).toContain("galopin enroll --cerea %s%s\\n");
		expect(ready).toContain("galopin enroll --connectors-only --cerea %s\\n");
		expect(ready).toContain("Workspace, Connectors, On your computers");
		const none = renderInstallScript("https://stack.example.org/chat");
		expect(none).not.toContain("galopin enroll --");
		expect(none).toContain('follow "Pair a computer"');
		expect(none).toContain("Cerea shows the exact command for your account");
		expect(spawnSync("sh", ["-n"], { input: ready }).status).toBe(0);
		expect(spawnSync("sh", ["-n"], { input: none }).status).toBe(0);
	});

	it("serves enroll.json with public facts only, and 404 without an issuer", async () => {
		const res = await serveGalopinFile("enroll.json", {
			origin: "https://stack.example.org/chat",
			issuer: " https://auth.example.org ",
			gateway: "https://stack.example.org",
			clientId: "machine-1",
		});
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^application\/json/);
		expect(JSON.parse(await text(res.body))).toEqual({
			issuer: "https://auth.example.org",
			gateway: "https://stack.example.org",
			clientId: "machine-1",
		});
		// The flow rides along only when the deployment fixes it.
		const flow = async (f?: string) =>
			JSON.parse(
				await text(
					(
						await serveGalopinFile("enroll.json", {
							origin: "https://x",
							issuer: "https://i",
							flow: f,
						})
					).body
				)
			);
		expect((await flow("device")).flow).toBe("device");
		expect((await flow("loopback")).flow).toBe("loopback");
		expect("flow" in (await flow("auto"))).toBe(false);
		expect("flow" in (await flow())).toBe(false);
		const none = await serveGalopinFile("enroll.json", { origin: "https://x" });
		expect(none.status).toBe(404);
	});

	it("quotes an origin safely", () => {
		expect(renderInstallScript("https://x.example/it's")).toContain(
			`origin='https://x.example/it'"'"'s'`
		);
	});

	it("prefers PUBLIC_ORIGIN over the request origin, and appends the base", () => {
		expect(galopinOrigin("http://10.0.0.5:3000", "/chat")).toBe("http://10.0.0.5:3000/chat");
		env.PUBLIC_ORIGIN = "https://stack.example.org/";
		expect(galopinOrigin("http://10.0.0.5:3000", "/chat")).toBe("https://stack.example.org/chat");
		env.PUBLIC_ORIGIN = "";
	});
});

describe("enroll.json and the session cookie's name", () => {
	it("carries the cookie's name (never a value) so the desktop app need not ask the page", async () => {
		const res = await serveGalopinFile("enroll.json", {
			origin: "https://s.example",
			issuer: "https://idp.example",
			clientId: "c",
			sessionCookie: "hf-chat",
		});
		expect(JSON.parse(String(res.body))).toMatchObject({ sessionCookie: "hf-chat" });
		const odd = await serveGalopinFile("enroll.json", {
			origin: "https://s.example",
			issuer: "https://idp.example",
			sessionCookie: "bad name; x",
		});
		expect(JSON.parse(String(odd.body))).not.toHaveProperty("sessionCookie");
	});
});
