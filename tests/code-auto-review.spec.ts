/**
 * Auto with a decision-model reviewer, end to end (ADR 0107): a session on Auto whose agent raises a
 * command ask. The real `galopin` and `opencode` run; the gateway is the hermetic mock, whose
 * `POST /v1/decisions` answers a scripted probability.
 *
 * The reviewer's credential is the machine owner's background grant, which exists only on a gateway
 * deployment (`USE_USER_TOKEN=true`), so this spec runs its own second app in that mode against the
 * stack's Mongo and mock gateway, and dials the machine to it. The stack's app is untouched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	test,
	expect,
	E2E_APP_PORT,
	E2E_DB_NAME,
	E2E_MONGO_URL,
	MOCK_OIDC_ISSUER,
	MOCK_OPENAI_BASE_URL,
	MOCK_OPENAI_ORIGIN,
} from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

const REVIEW_PORT = Number(process.env.E2E_REVIEW_APP_PORT ?? E2E_APP_PORT + 1);
const REVIEW_URL = `http://127.0.0.1:${REVIEW_PORT}`;
const SECRET_KEY = "e2e-review-secret-key";
const OWNER_TOKEN = "owner-grant-access-token";

/** `secretBox.seal` (AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>`), keyed like the app's. */
function seal(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		createHash("sha256").update(SECRET_KEY).digest(),
		iv
	);
	const body = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
	return [
		"v1",
		iv.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		body.toString("base64url"),
	].join(":");
}

async function control(path: string, data: unknown): Promise<void> {
	const res = await fetch(`${MOCK_OPENAI_ORIGIN}/__control/${path}`, {
		method: "POST",
		body: JSON.stringify(data),
	});
	expect(res.ok).toBe(true);
}

test.describe("Auto with a reviewer", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.skip(!existsSync("build/handler.js"), "needs the built app (npm run build)");
	test.describe.configure({ mode: "serial", timeout: 240_000 });

	let machine: Machine | null = null;
	let app: ChildProcess | null = null;
	let appLog = "";
	const workspaceOf = (): string => {
		if (!machine) throw new Error("no machine");
		return machine.workspace;
	};

	test.beforeAll(async () => {
		app = spawn("node", ["server.js"], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				HOST: "127.0.0.1",
				PORT: String(REVIEW_PORT),
				LOG_LEVEL: "warn",
				NODE_ENV: "production",
				// Pystino mode: each person's own token, no shared key.
				OPENAI_BASE_URL: MOCK_OPENAI_BASE_URL,
				USE_USER_TOKEN: "true",
				MONGODB_URL: E2E_MONGO_URL,
				MONGODB_DB_NAME: E2E_DB_NAME,
				MONGODB_DIRECT_CONNECTION: "true",
				PUBLIC_ORIGIN: REVIEW_URL,
				PUBLIC_APP_ASSETS: "chatui",
				COOKIE_NAME: "hf-chat",
				COOKIE_SECURE: "false",
				COOKIE_SAMESITE: "lax",
				ENABLE_CONFIG_MANAGER: "false",
				MCP_SERVERS: "[]",
				CODE_AGENTS_ENABLED: "true",
				OPENID_PROVIDER_URL: "http://127.0.0.1:9/authelia",
				CODE_MACHINE_ISSUER: MOCK_OIDC_ISSUER,
				CHAT_SECRET_KEY: SECRET_KEY,
				// Short, so the spec fails fast rather than waiting out a hung reviewer.
				AUTO_REVIEW_TIMEOUT_SECONDS: "10",
				AUTO_REVIEW_WATCHDOG_SECONDS: "30",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		app.stderr?.on("data", (c) => (appLog += c));
		await expect
			.poll(
				async () => {
					try {
						return (await fetch(`${REVIEW_URL}/healthcheck`)).status;
					} catch {
						return 0;
					}
				},
				{ timeout: 90_000, intervals: [500] }
			)
			.toBe(200);
	});

	test.afterAll(() => {
		app?.kill("SIGTERM");
		app = null;
	});

	test.afterEach(async ({ db }, testInfo) => {
		if (testInfo.status !== testInfo.expectedStatus) {
			testInfo.attach("galopin.log", { body: machine?.logs() ?? "", contentType: "text/plain" });
			testInfo.attach("review-app.log", { body: appLog, contentType: "text/plain" });
		}
		await machine?.stop();
		machine = null;
		await control("reset", {});
		for (const name of ["scheduleGrants", "agentReviewConfig", "agentReviewLog"]) {
			await db.collection(name).deleteMany({});
		}
	});

	/** Pairs a machine, makes a session and puts it on Auto. Returns once the composer is on Auto. */
	async function onAuto(
		page: import("playwright/test").Page,
		db: import("mongodb").Db,
		sessionId: string
	) {
		const sub = `e2e-${randomUUID()}`;
		const userId = await seedUser(db, sessionId, sub);
		// On a gateway the machine's token resolves through `/v1/me`, whose mock id is fixed.
		await db
			.collection("users")
			.updateOne({ _id: userId }, { $set: { gatewayUserId: "e2e-admin" } });
		await db.collection("sessions").updateOne(
			{ sessionId },
			{
				$set: {
					oauth: {
						token: { value: "owner-session-token", expiresAt: new Date(Date.now() + 86_400_000) },
					},
				},
			}
		);
		const now = new Date();
		await db.collection("scheduleGrants").insertOne({
			userId,
			refreshSealed: seal("refresh-token"),
			accessSealed: seal(OWNER_TOKEN),
			accessExpiresAt: new Date(Date.now() + 3_600_000),
			accessLifetimeMs: 3_600_000,
			scheduleUse: true,
			issuedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await db.collection("agentReviewConfig").updateOne(
			{},
			{
				$set: {
					enabled: true,
					decisionModelId: "mock-decider",
					threshold: 0.9,
					instructions: "",
					maxPerHourPerMachine: 300,
				},
			},
			{ upsert: true }
		);
		await control("scenario", {
			key: "default",
			scenario: {
				toolCalls: [
					{
						id: "call_auto",
						name: "bash",
						arguments: JSON.stringify({ command: "echo reviewed > out.txt", description: "write" }),
					},
				],
				content: ["Done", "."],
				chunkDelayMs: 10,
				finishReason: "stop",
				toolCallsOnce: true,
			},
		});
		machine = await startMachine({ sub, cerea: REVIEW_URL });

		await page.goto(`${REVIEW_URL}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(machine.name)).toBeVisible({ timeout: 90_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(machine.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(page.getByText("repo", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Build" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const auto = page.getByTestId("permission-mode-allow");
		await expect(auto).toHaveText(/Auto/);
		await auto.click();
		await expect(auto).toHaveAttribute("aria-checked", "true");
		return userId;
	}

	test("a high probability: the command runs, the log row exists, the card says Auto-allowed", async ({
		page,
		db,
		session,
	}) => {
		await control("decisions", { probability: 0.97 });
		const userId = await onAuto(page, db, session.sessionId);
		await page.getByRole("combobox").fill("write the file");
		await page.getByRole("button", { name: "Send message" }).click();

		// The reviewer answered: no card ever waits, the command ran.
		const out = join(workspaceOf(), "out.txt");
		await expect.poll(() => existsSync(out), { timeout: 90_000 }).toBe(true);
		expect(readFileSync(out, "utf8").trim()).toBe("reviewed");
		await expect(page.getByText("Auto-allowed by mock-decider (97%)")).toBeVisible({
			timeout: 30_000,
		});

		const rows = await db.collection("agentReviewLog").find({ userId }).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "allowed",
			class: "command",
			probability: 0.97,
			applied: true,
			modelId: "mock-decider",
			summary: "echo reviewed > out.txt",
		});

		// The call carried the owner's own background-grant token, and the fenced frame.
		const calls = (
			(await (await fetch(`${MOCK_OPENAI_ORIGIN}/__control/requests`)).json()) as Array<{
				path: string;
				body: { authorization?: string; model?: string; input?: string };
			}>
		).filter((r) => r.path === "/v1/decisions");
		expect(calls).toHaveLength(1);
		expect(calls[0].body.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
		expect(calls[0].body.model).toBe("mock-decider");
		expect(calls[0].body.input).toContain("echo reviewed > out.txt");
	});

	test("a low probability: the ask reaches the user with the reason, and nothing ran", async ({
		page,
		db,
		session,
	}) => {
		await control("decisions", { probability: 0.51 });
		const userId = await onAuto(page, db, session.sessionId);
		await page.getByRole("combobox").fill("write the file");
		await page.getByRole("button", { name: "Send message" }).click();

		await expect(page.getByLabel("Conversation messages").getByText("wants to call")).toBeVisible({
			timeout: 90_000,
		});
		await expect
			.poll(async () => db.collection("agentReviewLog").countDocuments({ userId }))
			.toBe(1);
		expect(existsSync(join(workspaceOf(), "out.txt"))).toBe(false);
		const row = await db.collection("agentReviewLog").findOne({ userId });
		expect(row).toMatchObject({ outcome: "escalated", probability: 0.51, applied: false });

		// The card carries the reviewer's words once the view reads the ask again.
		await page.reload();
		await expect(page.getByTestId("review-note").first()).toHaveText(
			"The reviewer wasn't sure enough (51%; it allows at 90%)"
		);
		await page
			.getByLabel("Conversation messages")
			.getByRole("button", { name: "Allow once" })
			.click();
		await expect
			.poll(() => existsSync(join(workspaceOf(), "out.txt")), { timeout: 60_000 })
			.toBe(true);
	});
});
