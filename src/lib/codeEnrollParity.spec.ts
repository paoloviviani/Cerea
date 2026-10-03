/**
 * Parity: the command the Pair-a-machine dialog prints, run for real, writes
 * the `policy.json` the dialog promised.
 *
 * This runs the dialog's own enroll step (`buildEnrollCommand`, through `sh`,
 * so the quoting is exactly what a person's shell sees) against the real
 * `galopin enroll`, with a stub identity provider (device flow) and a stub
 * gateway (billing groups only), then reads the files enroll wrote. Nothing is
 * asserted about the flags themselves: only that what the dialog promises
 * (`promisedPolicy`) is what the machine ends up holding.
 *
 * The binary is `GALOPIN_BIN`, else built once from `agent/` with `go build`;
 * the spec is skipped (loudly: it is listed as skipped) when neither exists.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEnrollCommand } from "./codeEnrollCommand";
import {
	DEFAULT_CEILING,
	defaultPolicyChoices,
	promisedPolicy,
	type EnrollPolicyChoices,
} from "./codeEnrollPolicy";

const AGENT_DIR = fileURLToPath(new URL("../../agent/", import.meta.url));
const GO =
	process.env.GO_BIN ?? (existsSync("/usr/local/go/bin/go") ? "/usr/local/go/bin/go" : "go");

function goAvailable(): boolean {
	if (process.env.GALOPIN_BIN) return existsSync(process.env.GALOPIN_BIN);
	try {
		execFileSync(GO, ["version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
const HAVE_BINARY = goAvailable();

let scratch: string;
let installDir: string;
let idp: Server;
let idpUrl: string;

function json(res: ServerResponse, body: unknown, status = 200) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => resolve(body));
	});
}

beforeAll(async () => {
	if (!HAVE_BINARY) return;
	scratch = mkdtempSync(join(tmpdir(), "enroll-parity-"));
	installDir = join(scratch, "bin");
	mkdirSync(installDir);
	const binary = process.env.GALOPIN_BIN ?? join(scratch, "galopin-built");
	if (!process.env.GALOPIN_BIN) {
		execFileSync(GO, ["build", "-o", binary, "."], { cwd: AGENT_DIR, stdio: "pipe" });
	}
	// The printed command invokes `${GALOPIN_INSTALL_DIR:-$HOME/.local/bin}/galopin`.
	execFileSync("ln", ["-s", binary, join(installDir, "galopin")]);

	// One server is both the identity provider (discovery, device flow, token)
	// and the gateway (the billing-group list enroll asks for).
	idp = createServer((req, res) => {
		void (async () => {
			const path = new URL(req.url ?? "/", idpUrl).pathname;
			if (path === "/.well-known/openid-configuration") {
				return json(res, {
					issuer: idpUrl,
					token_endpoint: `${idpUrl}/token`,
					device_authorization_endpoint: `${idpUrl}/device`,
				});
			}
			if (path === "/device") {
				await readBody(req);
				return json(res, {
					device_code: "dc",
					user_code: "ABCD-EFGH",
					verification_uri: `${idpUrl}/verify`,
					expires_in: 60,
					interval: 1,
				});
			}
			if (path === "/token") {
				await readBody(req);
				return json(res, {
					access_token: "at",
					refresh_token: "rt",
					expires_in: 3600,
					token_type: "Bearer",
				});
			}
			if (path === "/v1/billing/groups") {
				return json(res, { data: [{ id: "g1", name: "parity", is_default: true }] });
			}
			return json(res, { error: "not found" }, 404);
		})();
	});
	await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
	idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
}, 300_000);

afterAll(async () => {
	if (!HAVE_BINARY) return;
	await new Promise<void>((resolve) => idp.close(() => resolve()));
	rmSync(scratch, { recursive: true, force: true });
});

interface Enrolled {
	policy: Record<string, unknown> & {
		permission?: { max?: Record<string, string>; rules?: Record<string, string> };
	};
	opencode: { enabled_providers?: string[] };
}

/** Runs the dialog's enroll step as the person's shell would, and reads back
 * what it wrote. */
async function enrollWith(choices: EnrollPolicyChoices): Promise<Enrolled> {
	const dir = mkdtempSync(join(scratch, "machine-"));
	const command = buildEnrollCommand({
		origin: "https://cerea.example.org/chat",
		issuer: idpUrl,
		gatewayOrigin: idpUrl,
		...choices,
	});
	const steps = command.split(" &&\n");
	expect(steps).toHaveLength(3);
	// The command names the binary as ~/.local/bin/galopin; HOME is this
	// machine's scratch directory, so put the built binary there.
	mkdirSync(join(dir, ".local", "bin"), { recursive: true });
	execFileSync("ln", ["-s", join(installDir, "galopin"), join(dir, ".local", "bin", "galopin")]);
	const enrollStep = `${steps[1]} --device --no-discover --yes --output ${JSON.stringify(
		join(dir, "opencode.json")
	)} --creds ${JSON.stringify(join(dir, "creds.json"))}`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn("sh", ["-c", enrollStep], {
			env: {
				...process.env,
				HOME: dir,
				XDG_CONFIG_HOME: join(dir, "cfg"),
				GALOPIN_INSTALL_DIR: installDir,
				DISPLAY: "",
				WAYLAND_DISPLAY: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`enroll exited ${code}:\n${out}\n${enrollStep}`))
		);
	});
	return {
		policy: JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")),
		opencode: JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")),
	};
}

/** The fields the dialog promises, read from what enroll wrote. A field enroll
 * leaves out is read as the machine reads it (its documented default). */
function actualOf(enrolled: Enrolled) {
	const { policy, opencode } = enrolled;
	const word = (key: string, fallback: string) => (policy[key] as string | undefined) ?? fallback;
	return {
		permission: {
			max: policy.permission?.max ?? {},
			rules: policy.permission?.rules ?? {},
		},
		workspaceRoots: (policy.workspaceRoots as string[] | null) ?? [],
		allowFreeModels: policy.allowFreeModels === true,
		files: word("files", "read"),
		fileDeny: (policy.fileDeny as string[] | undefined) ?? [],
		noDefaultFileDeny: policy.noDefaultFileDeny === true,
		terminal: word("terminal", "denied"),
		maxTerminals: (policy.maxTerminals as number | undefined) ?? 8,
		commandShell: word("commandShell", "denied"),
		agentTools: word("agentTools", "allowed"),
		projectConfig: word("projectConfig", "denied"),
		backgroundSubagents: word("backgroundSubagents", "denied"),
		opencodeBuiltinProviders: opencode.enabled_providers === undefined,
	};
}

const choose = (over: Partial<EnrollPolicyChoices>): EnrollPolicyChoices => ({
	...defaultPolicyChoices(),
	...over,
});

describe.skipIf(!HAVE_BINARY)(
	"the printed command enrolls to the policy the dialog promised",
	() => {
		const scenarios: Array<[string, EnrollPolicyChoices]> = [
			["nothing touched", defaultPolicyChoices()],
			["terminal with a cap", choose({ allowTerminal: true, maxTerminals: 3 })],
			[
				"terminals, command shell and background subagents off",
				choose({
					allowTerminal: false,
					allowCommandShell: false,
					allowBackgroundSubagents: false,
				}),
			],
			[
				"one ceiling row changed: the whole set is written",
				choose({ ceiling: { ...DEFAULT_CEILING, edit: "ask" } }),
			],
			[
				"bash opened: the owner's opt-out",
				choose({ ceiling: { ...DEFAULT_CEILING, bash: "allow" } }),
			],
			[
				"every row Allow",
				choose({
					ceiling: Object.fromEntries(
						Object.keys(DEFAULT_CEILING).map((k) => [k, "allow"])
					) as typeof DEFAULT_CEILING,
				}),
			],
			["a row denied", choose({ ceiling: { ...DEFAULT_CEILING, webfetch: "deny" } })],
			["trust repos", choose({ allowProjectConfig: true })],
			[
				"the Advanced switches",
				choose({
					allowCommandShell: false,
					allowBackgroundSubagents: false,
					noAgentTools: true,
					allowFreeModels: true,
					allowOpencodeProvider: true,
				}),
			],
			[
				"a workspace root with spaces and a glob that must not expand",
				choose({
					workspaceRoots: ["/home/me/my projects", "/srv/it's"],
					fileDeny: ["*.pem", "config/prod?.yml"],
				}),
			],
			["files off, secret list dropped", choose({ noFiles: true, noDefaultFileDeny: true })],
			[
				"the machine's own rules",
				choose({
					permissionRules: [
						{ key: "edit", action: "ask" },
						{ key: "webfetch", action: "deny" },
					],
				}),
			],
			[
				"everything at once",
				choose({
					allowTerminal: true,
					maxTerminals: 2,
					ceiling: { ...DEFAULT_CEILING, edit: "ask", session_send: "deny" },
					allowProjectConfig: true,
					allowCommandShell: true,
					allowBackgroundSubagents: true,
					noAgentTools: true,
					allowFreeModels: true,
					allowOpencodeProvider: true,
					workspaceRoots: ["/a b"],
					noFiles: false,
					fileDeny: ["*.secret"],
					noDefaultFileDeny: true,
					permissionRules: [{ key: "bash", action: "ask" }],
				}),
			],
		];

		for (const [label, choices] of scenarios) {
			it(
				label,
				async () => {
					const enrolled = await enrollWith(choices);
					expect(actualOf(enrolled)).toEqual(promisedPolicy(choices));
				},
				60_000
			);
		}
	}
);
