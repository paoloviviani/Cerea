/**
 * Runs a real machine for the /code e2e: the `galopin` binary, built from
 * this repository's own `agent/`, which supervises a real `opencode serve`
 * whose only provider is the hermetic mock-openai, and dials the app's
 * `/api/v2/code/machine` with a token minted by the mock issuer. Nothing in
 * the chain between the browser and opencode is stubbed; only the LLM and
 * the IdP are.
 *
 * The binary comes from `GALOPIN_BIN`, or is built once per run from
 * `agent/` in this checkout.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Db, ObjectId } from "mongodb";
import { E2E_APP_URL, MOCK_OIDC_ISSUER, MOCK_OPENAI_BASE_URL } from "./fixtures.ts";

const AGENT_SRC = fileURLToPath(new URL("../agent", import.meta.url));
const GO =
	process.env.GO_BIN ?? (existsSync("/usr/local/go/bin/go") ? "/usr/local/go/bin/go" : "go");

/** The gateway provider id: the agent's free-model filter only admits `pystino/*`. */
export const MACHINE_MODEL = "pystino/mock-model";

/**
 * Everything the real-machine specs write (the built binary, machine roots,
 * galopin's and opencode's TMPDIR) lives on disk under ~/.cache/galopin-e2e,
 * never in /tmp: /tmp may be tmpfs, and opencode (a Bun binary) extracts
 * ~5 MB of native libraries into TMPDIR on every start and never removes
 * them. Each worker process gets its own `run-<pid>` dir, removed when it
 * exits; dirs left by a worker that was killed are swept on the next run.
 */
export const E2E_CACHE_ROOT = join(homedir(), ".cache", "galopin-e2e");
let scratchDir: string | null = null;

export function e2eScratch(): string {
	if (scratchDir) return scratchDir;
	mkdirSync(E2E_CACHE_ROOT, { recursive: true });
	for (const name of readdirSync(E2E_CACHE_ROOT)) {
		const pid = /^run-(\d+)$/.exec(name)?.[1];
		if (pid && !processAlive(Number(pid))) {
			rmSync(join(E2E_CACHE_ROOT, name), { recursive: true, force: true });
		}
	}
	const dir = join(E2E_CACHE_ROOT, `run-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	scratchDir = dir;
	return dir;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

let builtBinary: string | null = null;

export function agentBinary(): string {
	if (process.env.GALOPIN_BIN) return process.env.GALOPIN_BIN;
	if (builtBinary) return builtBinary;
	const out = join(e2eScratch(), "galopin");
	execFileSync(GO, ["build", "-o", out, "."], { cwd: AGENT_SRC, stdio: "pipe" });
	builtBinary = out;
	return out;
}

export function opencodeAvailable(): boolean {
	try {
		execFileSync("opencode", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** A signed-in user: the /code surface refuses anonymous sessions. */
export async function seedUser(db: Db, sessionId: string, sub: string): Promise<ObjectId> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Coder",
		username: "e2e-coder",
		hfUserId: sub,
		avatarUrl: undefined,
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("sessions").insertOne({
		sessionId,
		userId: insertedId,
		expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
		createdAt: now,
		updatedAt: now,
		// A freshly seeded session stands in for someone who "just signed
		// in" — the terminal's step-up rule (ADR 0090 D6) reads this, and
		// a session with none of its own counts as stale (never exempt),
		// which would otherwise send every e2e terminal test through a
		// real login redirect instead of minting a ticket.
		authTime: now,
	});
	// A signed-in person's settings are keyed by userId, not sessionId (authCondition):
	// move the fixture's welcome-dismissed settings over, or the modal inerts the app.
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

export interface Machine {
	name: string;
	root: string;
	/** A git-initialised directory the test registers as a workspace. */
	workspace: string;
	refreshToken: string;
	logs(): string;
	stop(): Promise<void>;
}

/**
 * The machine's permission policy (`policy.json` `permission`, what `enroll`'s
 * `--allow-auto-accept` / `--permission-max` / `--permission-rule` write).
 */
export interface MachinePermission {
	/** May a session be put on auto-accept at all (default "denied"). */
	responders?: "allowed" | "denied";
	/**
	 * The ceiling: the most a key may ever be. The default is what a fresh
	 * `enroll` writes — `bash` and `session_spawn` at "ask" — so a harness
	 * machine behaves like an enrolled one: Always on bash is answered "once",
	 * and the responder leaves bash to a person. A key left out is uncapped:
	 * pass `{ session_spawn: "ask" }` to open bash, or `{}` to cap nothing.
	 */
	max?: Record<string, "ask" | "deny">;
	/** The machine's own rules (applied to every session, capped by `max`). */
	rules?: Record<string, "allow" | "ask" | "deny">;
}

/** What a fresh `enroll` writes as the ceiling. */
export const ENROLL_DEFAULT_MAX: Record<string, "ask" | "deny"> = {
	bash: "ask",
	session_spawn: "ask",
};

/** The machine's own policy (`policy.json`, what `enroll` flags would write). */
export interface MachinePolicy {
	/** Shorthand for `permission.responders` (the field's old name). */
	autoAccept?: "allowed" | "denied";
	permission?: MachinePermission;
	allowFreeModels?: boolean;
	workspaceRoots?: string[];
	/** The terminal veto (ADR 0090, default "denied"; `enroll --allow-terminal`). */
	terminal?: "allowed" | "denied";
	maxTerminals?: number;
}

export async function startMachine(input: {
	sub: string;
	name?: string;
	policy?: MachinePolicy;
}): Promise<Machine> {
	const name = input.name ?? `e2e-box-${randomUUID().slice(0, 6)}`;
	const root = mkdtempSync(join(e2eScratch(), "machine-"));
	const tmp = join(root, "tmp");
	mkdirSync(tmp);
	const workspace = join(root, "repo");
	mkdirSync(workspace);
	execFileSync("git", ["init", "-q"], { cwd: workspace });
	writeFileSync(join(workspace, "README.md"), "# e2e repo\n");

	const minted = (await (
		await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
			method: "POST",
			body: JSON.stringify({ sub: input.sub }),
		})
	).json()) as { access_token: string; refresh_token: string; expires_in: number };

	const creds = join(root, "creds.json");
	writeFileSync(
		creds,
		JSON.stringify({
			issuer: MOCK_OIDC_ISSUER,
			token_endpoint: `${MOCK_OIDC_ISSUER}/token`,
			client_id: "opencode-enrollment",
			gateway: MOCK_OPENAI_BASE_URL,
			group: "",
			refresh_token: minted.refresh_token,
			access_token: minted.access_token,
			expires_in: minted.expires_in,
			obtained_at_unix: Math.floor(Date.now() / 1000),
		}),
		{ mode: 0o600 }
	);

	const [providerId, modelId] = MACHINE_MODEL.split("/");
	const opencodeConfig = join(root, "opencode.json");
	writeFileSync(
		opencodeConfig,
		JSON.stringify({
			$schema: "https://opencode.ai/config.json",
			provider: {
				[providerId]: {
					npm: "@ai-sdk/openai-compatible",
					name: "Pystino (mock)",
					options: { baseURL: MOCK_OPENAI_BASE_URL, apiKey: "e2e" },
					models: {
						[modelId]: {
							name: "Mock Model",
							limit: { context: 128000, output: 8192 },
							// The thinking-effort levels galopin enroll writes for a
							// reasoning-capable gateway model.
							variants: {
								low: { reasoningEffort: "low" },
								medium: { reasoningEffort: "medium" },
								high: { reasoningEffort: "high" },
							},
						},
					},
				},
				// A non-gateway provider: listed by opencode, but off the panel unless the
				// machine allows free models.
				freebie: {
					npm: "@ai-sdk/openai-compatible",
					name: "Free (mock)",
					options: { baseURL: MOCK_OPENAI_BASE_URL, apiKey: "e2e" },
					models: { "free-model": { name: "Free Model" } },
				},
			},
			model: MACHINE_MODEL,
			small_model: MACHINE_MODEL,
			permission: { edit: "ask", bash: "ask", webfetch: "ask" },
			share: "disabled",
			autoupdate: false,
		})
	);

	// opencode keeps its data under XDG dirs; isolate them so the run never sees the
	// developer's own sessions, auth or config.
	const home = join(root, "home");
	mkdirSync(home);
	const stateDir = join(root, "state");
	mkdirSync(stateDir);
	// Always written: a machine enrolled by the real command has a policy.json
	// with the default ceiling, and the permission specs depend on it.
	const policy = input.policy ?? {};
	writeFileSync(
		join(stateDir, "policy.json"),
		JSON.stringify({
			permission: {
				responders: policy.permission?.responders ?? policy.autoAccept ?? "denied",
				max: policy.permission?.max ?? ENROLL_DEFAULT_MAX,
				...(policy.permission?.rules ? { rules: policy.permission.rules } : {}),
			},
			allowFreeModels: policy.allowFreeModels ?? false,
			workspaceRoots: policy.workspaceRoots ?? [],
			...(policy.terminal ? { terminal: policy.terminal } : {}),
			...(policy.maxTerminals ? { maxTerminals: policy.maxTerminals } : {}),
		})
	);
	let output = "";
	const child: ChildProcess = spawn(
		agentBinary(),
		[
			"run",
			"--state-dir",
			stateDir,
			"--creds",
			creds,
			"--cerea",
			E2E_APP_URL,
			"--no-shim",
			"--opencode-config",
			opencodeConfig,
			"--machine-name",
			name,
		],
		{
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				XDG_DATA_HOME: join(home, ".local/share"),
				XDG_STATE_HOME: join(home, ".local/state"),
				TMPDIR: tmp,
				// Shared across runs: opencode installs its provider packages here on first start,
				// and a cold install per test would dominate the run.
				XDG_CACHE_HOME:
					process.env.PYSTINO_E2E_OPENCODE_CACHE ?? join(E2E_CACHE_ROOT, "opencode-cache"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
	child.stdout?.on("data", (chunk) => (output += chunk));
	child.stderr?.on("data", (chunk) => (output += chunk));

	return {
		name,
		root,
		workspace,
		refreshToken: minted.refresh_token,
		logs: () => output,
		stop: async () => {
			if (child.exitCode === null) {
				const exited = new Promise((resolve) => child.once("exit", resolve));
				child.kill("SIGTERM");
				await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}
