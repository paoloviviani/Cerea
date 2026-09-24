import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const env = vi.hoisted(() => ({ GALOPIN_DIST_DIR: "", PUBLIC_ORIGIN: "" }));
vi.mock("$lib/server/config", () => ({ config: env }));

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
		expect(script).toContain("galopin enroll --cerea %s");
		expect(script).toContain("checksum mismatch");
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
