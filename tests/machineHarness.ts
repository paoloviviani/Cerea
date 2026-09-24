/**
 * Runs a real machine for the /code e2e: the `pystino-agent` binary (Pystino
 * `deploy/agent`), which supervises a real `opencode serve` whose only provider is
 * the hermetic mock-openai, and dials the app's `/api/v2/code/machine` with a
 * token minted by the mock issuer. Nothing in the chain between the browser and
 * opencode is stubbed; only the LLM and the IdP are.
 *
 * The binary comes from `PYSTINO_AGENT_BIN`, or is built from `PYSTINO_AGENT_SRC`
 * (default: the sibling Pystino worktree) once per run.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db, ObjectId } from "mongodb";
import { E2E_APP_URL, MOCK_OIDC_ISSUER, MOCK_OPENAI_BASE_URL } from "./fixtures.ts";

const AGENT_SRC =
	process.env.PYSTINO_AGENT_SRC ?? "/home/ubuntu/.paseo/worktrees/thin-pystino/deploy/agent";
const GO =
	process.env.GO_BIN ?? (existsSync("/usr/local/go/bin/go") ? "/usr/local/go/bin/go" : "go");

/** The gateway provider id: the agent's free-model filter only admits `pystino/*`. */
export const MACHINE_MODEL = "pystino/mock-model";

let builtBinary: string | null = null;

export function agentBinary(): string {
	if (process.env.PYSTINO_AGENT_BIN) return process.env.PYSTINO_AGENT_BIN;
	if (builtBinary) return builtBinary;
	const out = join(tmpdir(), `pystino-agent-e2e-${process.pid}`);
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

/** The machine's own policy (`policy.json`, what `enroll` flags would write). */
export interface MachinePolicy {
	autoAccept?: "allowed" | "denied";
	allowFreeModels?: boolean;
	workspaceRoots?: string[];
}

export async function startMachine(input: {
	sub: string;
	name?: string;
	policy?: MachinePolicy;
}): Promise<Machine> {
	const name = input.name ?? `e2e-box-${randomUUID().slice(0, 6)}`;
	const root = mkdtempSync(join(tmpdir(), "pystino-machine-"));
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
					models: { [modelId]: { name: "Mock Model", limit: { context: 128000, output: 8192 } } },
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
	if (input.policy) {
		writeFileSync(
			join(stateDir, "policy.json"),
			JSON.stringify({
				autoAccept: input.policy.autoAccept ?? "denied",
				allowFreeModels: input.policy.allowFreeModels ?? false,
				workspaceRoots: input.policy.workspaceRoots ?? [],
			})
		);
	}
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
				// Shared across runs: opencode installs its provider packages here on first start,
				// and a cold install per test would dominate the run.
				XDG_CACHE_HOME:
					process.env.PYSTINO_E2E_OPENCODE_CACHE ?? join(tmpdir(), "pystino-e2e-opencode-cache"),
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
