/**
 * cerea-browser: the browser runtime for Cerea (ADR 0116), an MCP server over stdio or HTTP.
 *
 *   node main.ts --profile DIR [--headless | --headed] [--http PORT [--host H] [--token T]]
 */

import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { serveHttp, serveStdio } from "./server.ts";
import { BrowserSession, DEFAULT_MAX_SNAPSHOT_CHARS } from "./session.ts";

const USAGE = `cerea-browser: browser runtime for Cerea (MCP server).

Usage: cerea-browser --profile DIR [options]

  --profile DIR        Persistent Chromium profile (cookies, logins). Or $CEREA_BROWSER_PROFILE.
  --headless           No window (the default).
  --headed             Show the browser window.
  --http PORT          Serve MCP over Streamable HTTP on /mcp instead of stdio.
  --host ADDR          With --http: the address to bind (default 127.0.0.1).
  --token TOKEN        With --http: require this bearer token. Or $CEREA_BROWSER_TOKEN.
  --key-file PATH      File holding this device's approval key (0600), or $CEREA_BROWSER_KEY.
                       Without a key no approval is accepted, so nothing commit-class runs.
  --no-sandbox         Start Chromium without its sandbox (containers, root).
  --executable PATH    Use this Chromium instead of the one Playwright installed.
  --max-snapshot-chars N   Size budget of one snapshot (default ${DEFAULT_MAX_SNAPSHOT_CHARS}).
  --idle-minutes N     Close the task's pages after N minutes without a call (default 10).
  --viewport WxH       Viewport of a headless browser (default 1280x800).
  --self-test          Start Chromium once and report: {"ok":true,"sandbox":true|false,"version":"..."}.
  -h, --help           This text.
`;

function fail(message: string): never {
	process.stderr.write(`cerea-browser: ${message}\n`);
	process.exit(2);
}

const { values } = (() => {
	try {
		return parseArgs({
			options: {
				profile: { type: "string" },
				headless: { type: "boolean" },
				headed: { type: "boolean" },
				http: { type: "string" },
				host: { type: "string" },
				token: { type: "string" },
				"no-sandbox": { type: "boolean" },
				"key-file": { type: "string" },
				"idle-minutes": { type: "string" },
				executable: { type: "string" },
				"max-snapshot-chars": { type: "string" },
				viewport: { type: "string" },
				"self-test": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
})();

if (values.help) {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (values.headless && values.headed) fail("--headless and --headed contradict each other.");
if (values["self-test"]) {
	process.exit(await selfTest(values.executable));
}
const profileDir = values.profile ?? process.env.CEREA_BROWSER_PROFILE;
if (!profileDir) fail("--profile DIR is required.");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const maxChars = values["max-snapshot-chars"] ? Number(values["max-snapshot-chars"]) : undefined;
if (maxChars !== undefined && !(maxChars >= 1000 && maxChars <= 200_000)) {
	fail("--max-snapshot-chars must be between 1000 and 200000.");
}
let viewport: { width: number; height: number } | undefined;
if (values.viewport) {
	const m = /^(\d{3,4})x(\d{3,4})$/.exec(values.viewport);
	if (!m) fail("--viewport must look like 1280x800.");
	viewport = { width: Number(m[1]), height: Number(m[2]) };
}

const session = new BrowserSession({
	profileDir,
	headless: !values.headed,
	noSandbox: values["no-sandbox"] === true,
	executablePath: values.executable,
	keyFile: values["key-file"],
	...(values["idle-minutes"] ? { idleMs: Number(values["idle-minutes"]) * 60_000 } : {}),
	maxSnapshotChars: maxChars,
	viewport,
});

if (values.http !== undefined) {
	const port = Number(values.http);
	if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--http needs a port number.");
	const server = await serveHttp(session, {
		port,
		host: values.host ?? "127.0.0.1",
		token: values.token ?? process.env.CEREA_BROWSER_TOKEN,
	});
	const address = server.address();
	process.stderr.write(
		`cerea-browser: serving MCP on http://${values.host ?? "127.0.0.1"}:${typeof address === "object" && address ? address.port : port}/mcp\n`
	);
	const stop = () => {
		server.close();
		void session.close().finally(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
} else {
	await serveStdio(session);
}

/**
 * Starts Chromium headless on a throw-away profile, with its sandbox and, failing that, without:
 * the answer tells `galopin browser setup` whether the sandbox works on this computer.
 */
async function selfTest(executablePath: string | undefined): Promise<number> {
	const profile = await mkdtemp(join(tmpdir(), "cerea-browser-selftest-"));
	try {
		for (const sandbox of [true, false]) {
			try {
				const context = await chromium.launchPersistentContext(profile, {
					headless: true,
					chromiumSandbox: sandbox,
					...(executablePath ? { executablePath } : {}),
				});
				const version = context.browser()?.version() ?? "";
				await context.close();
				process.stdout.write(`${JSON.stringify({ ok: true, sandbox, version })}\n`);
				return 0;
			} catch (err) {
				if (!sandbox) {
					const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
					process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
				}
			}
		}
		return 1;
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
}
