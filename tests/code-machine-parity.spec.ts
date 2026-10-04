/**
 * Parity milestones against a real machine (the same chain as the P0 spec: the real
 * `galopin` supervising a real `opencode serve`, only the LLM and the IdP mocked).
 * Each test pairs its own machine, so a policy set for one never leaks into another.
 *
 * The permission-selector cases (Deny · Ask · Allow, and "Always allow (this
 * session)" exceptions) are written against the FROZEN contract in the
 * permission-selector brief; the agent half is built concurrently on
 * feat/permission-selector-agent. They need that galopin to pass, so OC's
 * end-to-end reconcile is where they are first run against the real thing.
 */
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import {
	opencodeAvailable,
	seedUser,
	startMachine,
	type Machine,
	type MachinePolicy,
} from "./machineHarness";
import type { Db } from "mongodb";

test.describe("owned machine agent: parity", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 180_000 });

	let machine: Machine | null = null;
	let consoleLines: string[] = [];

	test.beforeEach(({ page }) => {
		consoleLines = [];
		page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
		page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.stack ?? err.message}`));
	});

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine && testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("galopin.log", {
				body: machine.logs(),
				contentType: "text/plain",
			});
			// Also on disk: an attachment's body lives only in the report.
			writeFileSync(testInfo.outputPath("galopin.log"), machine.logs());
			writeFileSync(testInfo.outputPath("browser-console.log"), consoleLines.join("\n"));
		}
		await machine?.stop();
		machine = null;
	});

	/** Pair a fresh machine, add its repo as a workspace and open a new session. */
	async function openSession(
		page: Page,
		db: Db,
		sessionId: string,
		policy?: MachinePolicy
	): Promise<Machine> {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, sessionId, sub);
		const started = await startMachine({ sub, policy });
		machine = started;
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(started.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(started.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Build" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByRole("combobox")).toBeEnabled({ timeout: 30_000 });
		return started;
	}

	async function send(page: Page, text: string): Promise<void> {
		await page.getByRole("combobox").fill(text);
		await page.getByRole("button", { name: "Send message" }).click();
	}

	/**
	 * The agent transcript's approval card. Scoped, never page-global: the
	 * Needs-you inbox mirrors every pending ask, so once its poll picks one
	 * up a page-global button lookup goes ambiguous and strict-mode fails
	 * depending on poll timing. Answering here is the same backend call.
	 */
	const transcriptCard = (page: Page) => page.getByLabel("Conversation messages");

	/**
	 * A file write through opencode's own write tool (permission key `edit`).
	 * Under Allow it runs without a card; `bash`, capped at ask by the
	 * enroll-default ceiling, still asks a person.
	 */
	const writeFileScenario = {
		toolCalls: [
			{
				id: "call_w",
				name: "write",
				arguments: JSON.stringify({ filePath: "out.txt", content: "parity\n" }),
			},
		],
		content: ["Wrote", " it", "."],
		chunkDelayMs: 10,
		finishReason: "stop" as const,
	};

	test("models: only gateway models are offered, and the pill says how many were hidden", async ({
		page,
		db,
		session,
	}) => {
		await openSession(page, db, session.sessionId);
		await page.getByRole("button", { name: "Model" }).click();
		await expect(page.getByRole("menuitem", { name: "Mock Model" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Free Model" })).toHaveCount(0);
		// opencode lists its own free catalog as well as the harness's "freebie" provider.
		await expect(page.getByText(/\d+ non-gateway models? hidden/)).toBeVisible();
	});

	const selector = (page: Page) =>
		page.getByRole("radiogroup", { name: "Permission for this session" });
	const choose = async (page: Page, mode: "Deny" | "Ask" | "Allow") => {
		await selector(page).getByRole("radio", { name: mode }).click();
		await expect(selector(page).getByRole("radio", { name: mode })).toHaveAttribute(
			"aria-checked",
			"true"
		);
	};

	test("selector: a new session starts on Ask, and under Allow names what the machine still caps", async ({
		page,
		db,
		session,
	}) => {
		await openSession(page, db, session.sessionId);
		await expect(selector(page).getByRole("radio", { name: "Ask" })).toHaveAttribute(
			"aria-checked",
			"true"
		);
		await expect(page.getByRole("button", { name: /auto.?accept/i })).toHaveCount(0);
		await choose(page, "Allow");
		// The enroll-default ceiling holds bash at ask.
		await expect(page.getByTestId("permission-mode-note")).toHaveText(
			/Allow · .*bash asks.*\(machine limit\)/
		);
	});

	const bashWriteScenario = (id: string, file: string, words: string[]) => ({
		toolCalls: [
			{
				id,
				name: "bash",
				arguments: JSON.stringify({
					command: `echo ${file} > ${file}.txt`,
					description: `write ${file}`,
				}),
			},
		],
		toolCallsOnce: true,
		content: words,
		chunkDelayMs: 10,
		finishReason: "stop" as const,
	});

	test("approvals: under the default ceiling (bash asks) there is no Always allow, so every call asks", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario(bashWriteScenario("call_a", "a", ["First", " done", "."]));
		await send(page, "write a");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		// The ceiling holds bash at ask: an "always" would store nothing, so the
		// card does not offer one. Scoped to the transcript: the Needs-you
		// inbox mirrors the same ask, so a page-global lookup goes ambiguous
		// once its poll picks the ask up.
		const transcript = page.getByLabel("Conversation messages");
		await expect(transcript.getByRole("button", { name: "Allow once" })).toBeVisible();
		await expect(
			transcript.getByRole("button", { name: "Always allow (this session)" })
		).toHaveCount(0);
		await transcript.getByRole("button", { name: "Allow once" }).click();
		await expect(transcriptCard(page).getByText("First done.")).toBeVisible({ timeout: 60_000 });

		await mockOpenAI.setDefaultScenario(bashWriteScenario("call_b", "b", ["Second", " done", "."]));
		await send(page, "write b");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await transcript.getByRole("button", { name: "Allow once" }).click();
		await expect(transcriptCard(page).getByText("Second done.")).toBeVisible({ timeout: 60_000 });
	});

	test("approvals: with bash left uncapped, Always allow (this session) adds an exception that the Permissions line lists, and Remove makes it ask again", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId, {
			permission: { max: { session_spawn: "ask" } },
		});

		const bashScenario = (id: string, file: string, words: string[]) => ({
			toolCalls: [
				{
					id,
					name: "bash",
					arguments: JSON.stringify({ command: "echo same", description: `write ${file}` }),
				},
			],
			toolCallsOnce: true,
			content: words,
			chunkDelayMs: 10,
			finishReason: "stop" as const,
		});
		await mockOpenAI.setDefaultScenario(bashScenario("call_a", "a", ["First", " done", "."]));
		await send(page, "run it");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await transcriptCard(page).getByRole("button", { name: "Always allow (this session)" }).click();
		await expect(transcriptCard(page).getByText("First done.")).toBeVisible({ timeout: 60_000 });

		// The same command now runs with no second prompt: an exception, on top of Ask.
		await mockOpenAI.setDefaultScenario(bashScenario("call_b", "b", ["Second", " done", "."]));
		await send(page, "run it again");
		await expect(transcriptCard(page).getByText("Second done.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);

		// The Permissions line lists it, and Remove takes it away.
		// The exception reads "bash echo *": opencode scopes a bash
		// "always" to "<command> *", and galopin stores its patterns
		// verbatim (probed live: "echo same" arrives as always ["echo *"],
		// "git status" as ["git status *"]) — the panel shows what is in
		// force, never a narrower promise.
		await page.getByRole("button", { name: /^Permissions/ }).click();
		const item = page.getByTestId("permission-exception-item");
		await expect(item).toHaveCount(1, { timeout: 30_000 });
		await expect(item).toContainText("echo *");
		await item.getByRole("button", { name: /Remove exception/ }).click();
		await expect(page.getByTestId("permission-exception-item")).toHaveCount(0, { timeout: 30_000 });

		// Removed: that command asks again.
		await mockOpenAI.setDefaultScenario(bashScenario("call_c", "c", ["Third", " done", "."]));
		await send(page, "and once more");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
		await expect(transcriptCard(page).getByText("Third done.")).toBeVisible({ timeout: 60_000 });
	});

	test("selector Allow: bash under the default ceiling is still a card (the ceiling is the one thing Cerea cannot raise)", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await choose(page, "Allow");
		await mockOpenAI.setDefaultScenario(bashWriteScenario("call_c", "c", ["Wrote", " c", "."]));
		await send(page, "write c");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		expect(existsSync(join(m.workspace, "c.txt"))).toBe(false);
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
		await expect(transcriptCard(page).getByText("Wrote c.")).toBeVisible({ timeout: 60_000 });
		expect(existsSync(join(m.workspace, "c.txt"))).toBe(true);
	});

	test("selector Allow: an edit runs without asking, and the diff shows the change", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await choose(page, "Allow");
		await mockOpenAI.setDefaultScenario(writeFileScenario);
		await send(page, "write the file");
		await expect(page.getByText("Wrote it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(true);

		await page.getByRole("button", { name: "Changes" }).click();
		await expect(page.getByText("out.txt").first()).toBeVisible({ timeout: 20_000 });
	});

	test("selector Ask: an edit is a card, and nothing is written until it is allowed", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario(writeFileScenario);
		await send(page, "write the file");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(false);
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
		await expect(page.getByText("Wrote it.")).toBeVisible({ timeout: 60_000 });
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(true);
	});

	test("selector Deny: an edit is refused without a card, and nothing is written", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await choose(page, "Deny");
		await mockOpenAI.setDefaultScenario(writeFileScenario);
		await send(page, "write the file");
		await expect(page.getByText("Wrote it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(false);
	});

	test("files: an attached file reaches the agent and renders on the user message", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			content: ["Read", " it", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await page.locator('input[type="file"]').setInputFiles({
			name: "notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("marker-7f3a lives in the notes\n"),
		});
		await send(page, "read the notes");
		await expect(page.getByText("Read it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("notes.txt").first()).toBeVisible();
		// The bytes went through the store, over the machine's socket, into opencode's prompt.
		const requests = await mockOpenAI.requests();
		expect(requests.some((r) => JSON.stringify(r.body).includes("marker-7f3a"))).toBe(true);
	});

	test("thinking: a model's reasoning is a collapsed Thinking block beside the answer, live and after a reload", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		// opencode's openai-compatible provider turns `reasoning_content` deltas
		// into a reasoning part, then the content into a separate text part.
		await mockOpenAI.setDefaultScenario({
			reasoning: ["Weighing ", "the two ", "sandbox options."],
			reasoningField: "reasoning_content",
			content: ["Option ", "B ", "wins."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "which sandbox?");
		const reply = page.locator('[data-message-role="assistant"]');
		const thinkingBlock = reply.getByRole("button", { name: "Expand" });
		const checkShape = async () => {
			await expect(reply.getByText("Option B wins.")).toBeVisible({ timeout: 60_000 });
			// Collapsed: the label is there, the reasoning text is not shown.
			await expect(reply.getByText("Thinking", { exact: true })).toBeVisible();
			await expect(thinkingBlock).toHaveCount(1);
			await expect(reply.getByText("Weighing the two sandbox options.")).toHaveCount(0);
			// The answer is the answer alone: the thinking is not glued onto it.
			await expect(reply.locator(".prose").filter({ hasText: "Option B wins." })).not.toContainText(
				"Weighing"
			);
			await thinkingBlock.click();
			await expect(reply.getByText("Weighing the two sandbox options.")).toBeVisible();
			await reply.getByRole("button", { name: "Collapse" }).click();
		};
		await checkShape();
		await page.reload();
		await checkShape();
	});

	/**
	 * One scenario serving a whole subagent tree: the parent's prompt gets
	 * a `task` call, while the child's own prompt — which echoes the task
	 * text — routes to a `bash` call that needs a permission. The mock
	 * answers tool results with text (its `role: "tool"` check), so neither
	 * side loops. The child's command names the workspace absolutely: the
	 * point under test is the approval round trip, not opencode's working
	 * directory for subagents.
	 */
	const subagentApprovalScenario = (workspace: string) => ({
		toolCalls: [
			{
				id: "call_task",
				name: "task",
				arguments: JSON.stringify({
					description: "Inspect the repo",
					prompt: "List what is in the repo.",
					subagent_type: "general",
				}),
			},
		],
		toolCallsOnce: true,
		content: ["Parent", " done", "."],
		chunkDelayMs: 10,
		finishReason: "stop" as const,
		routes: [
			{
				contains: "List what is in the repo.",
				scenario: {
					toolCalls: [
						{
							id: "call_child_bash",
							name: "bash",
							arguments: JSON.stringify({
								command: `echo child-marker > ${workspace}/child.txt`,
								description: "write child file",
							}),
						},
					],
					toolCallsOnce: true,
					content: ["Child", " done", "."],
					chunkDelayMs: 10,
					finishReason: "stop" as const,
				},
			},
		],
	});

	/**
	 * Under Ask the parent's own `task` call is a card of its own, and it comes
	 * first: there is no child until a person lets the parent spawn one. Answer
	 * it, then the child's ask is the next card in the transcript.
	 */
	async function allowTheSpawn(page: Page): Promise<void> {
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await expect(
			transcriptCard(page)
				.locator("code")
				.filter({ hasText: /^task$/ })
		).toBeVisible();
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
	}

	test("files: the explorer lists the real workspace, badges and redacts, and refreshes after a turn", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		// A committed file then modified, a secret, and a link out of the root.
		writeFileSync(join(m.workspace, "app.ts"), "export const a = 1;\n");
		const git = (...args: string[]) =>
			execFileSync("git", [
				"-C",
				m.workspace,
				"-c",
				"user.email=e@x",
				"-c",
				"user.name=e",
				...args,
			]);
		git("add", "app.ts");
		git("commit", "-q", "-m", "init");
		writeFileSync(join(m.workspace, "app.ts"), "export const a = 2;\n");
		writeFileSync(join(m.workspace, ".env"), "TOKEN=hunter2\n");
		symlinkSync("/etc/hostname", join(m.workspace, "escape"));

		await page.getByRole("button", { name: "Files" }).click();
		const tree = page.getByRole("tree", { name: "Workspace files" });
		await expect(tree).toBeVisible({ timeout: 30_000 });
		const row = (name: string) => tree.getByRole("button", { name: new RegExp(`^${name}`) });
		await expect(row("app.ts")).toContainText("M");
		await expect(row(".env")).toBeVisible();
		await expect(row(".env").getByLabel("Hidden by this machine's policy")).toBeVisible();

		// Opening a file shows its content; the secret shows why it does not.
		await row("app.ts").click();
		await expect(page.getByTestId("file-viewer")).toContainText("export const a = 2;", {
			timeout: 30_000,
		});
		await page.getByTestId("code-files").getByRole("button", { name: "Back to files" }).click();
		await row(".env").click();
		await expect(page.getByTestId("code-files")).toContainText("Hidden by this machine's policy");
		await expect(page.getByTestId("code-files")).not.toContainText("hunter2");
		await page.getByTestId("code-files").getByRole("button", { name: "Back to files" }).click();
		// The link out of the workspace is listed but never read through.
		await row("escape").click();
		await expect(page.getByTestId("code-files")).toContainText(/leaves the workspace|forbidden/i, {
			timeout: 30_000,
		});
		await page.getByTestId("code-files").getByRole("button", { name: "Back to files" }).click();

		// A turn that writes a file: the tree shows it once the turn settles.
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_w",
					name: "bash",
					arguments: JSON.stringify({
						command: "echo hi > made-by-agent.txt",
						description: "write",
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Wrote", " it", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "write a file");
		await expect(transcriptCard(page).getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Wrote it.")
		).toBeVisible({
			timeout: 60_000,
		});
		await expect(row("made-by-agent.txt")).toBeVisible({ timeout: 30_000 });
	});

	test("effort: the pill names the real model, and a picked effort reaches the model as reasoning_effort", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		// The model/effort pill — the chat composer's own `ModelEffortPicker`
		// — names the backend's default model, not "Model".
		const pill = page.getByRole("button", { name: "Model and effort" });
		await expect(pill).toContainText("Mock Model", { timeout: 30_000 });
		await expect(pill).toContainText("Default");
		await pill.click();
		await page.getByRole("menuitem", { name: /Effort/ }).click();
		await page.getByRole("menuitem", { name: "High", exact: true }).click();
		await expect(pill).toContainText("High", { timeout: 30_000 });

		await mockOpenAI.setDefaultScenario({ content: ["Thought", " hard."], chunkDelayMs: 5 });
		await send(page, "think about it");
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Thought hard.")
		).toBeVisible({ timeout: 60_000 });
		// opencode's request to the model carries the variant's reasoning effort.
		await expect
			.poll(async () =>
				(await mockOpenAI.requests()).some(
					(r) => r.path === "/v1/chat/completions" && r.body.reasoning_effort === "high"
				)
			)
			.toBe(true);
	});

	test("retry: rolling back to a prompt drops the turn after it and sends the prompt again", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		// Answers are looked for in the transcript, and each turn is let settle
		// before the next scenario: opencode also asks the mock for a session
		// title, which would otherwise show the same text in the sidebar first.
		const transcript = page.locator('[data-message-role="assistant"]');
		const settle = () =>
			expect(page.getByText("done", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
		await mockOpenAI.setDefaultScenario({ content: ["Answer", " one."], chunkDelayMs: 5 });
		await send(page, "first question");
		await expect(transcript.getByText("Answer one.")).toBeVisible({ timeout: 60_000 });
		await settle();
		await mockOpenAI.setDefaultScenario({ content: ["Answer", " two."], chunkDelayMs: 5 });
		await send(page, "second question");
		await expect(transcript.getByText("Answer two.")).toBeVisible({ timeout: 60_000 });
		await settle();

		// Retry on the second answer: confirm, and the confirmation says whether
		// files come back (the harness workspace is a git repository, so yes).
		await mockOpenAI.setDefaultScenario({ content: ["Answer", " two, again."], chunkDelayMs: 5 });
		// Retry is offered on both answers only once the second turn is done.
		await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(2, { timeout: 60_000 });
		await transcript.last().hover();
		await page.getByRole("button", { name: "Retry" }).last().click();
		await expect(page.getByRole("dialog")).toContainText("second question");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Retry from here?");
		await expect(dialog).toContainText("restored too");
		await dialog.getByRole("button", { name: "Roll back and send" }).click();

		// The old second turn is gone, the prompt went again once, and the new
		// answer streams in after the untouched first turn.
		await expect(transcript.getByText("Answer two, again.")).toBeVisible({ timeout: 60_000 });
		await expect(transcript.getByText("Answer two.", { exact: true })).toHaveCount(0);
		await expect(page.getByText("second question")).toHaveCount(1);
		await expect(transcript.getByText("Answer one.")).toBeVisible();

		// The same survives a reload: it is the machine's history now.
		await page.reload();
		await expect(transcript.getByText("Answer two, again.")).toBeVisible({ timeout: 60_000 });
		await expect(transcript.getByText("Answer two.", { exact: true })).toHaveCount(0);
		// The fork action is named Fork now.
		await page.locator('[data-message-role="assistant"]').last().hover();
		await expect(page.getByRole("button", { name: "Fork from here" }).last()).toBeVisible();
	});

	test("subagent approvals: a child's bash permission surfaces as a labelled card mid-turn, and approving lets the child finish", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario(subagentApprovalScenario(m.workspace));
		await send(page, "delegate this");

		await allowTheSpawn(page);

		// The child's card arrives mid-turn (the turn is still held on it),
		// labelled as the subagent's — a parent's own ask never says "Subagent".
		await expect(transcriptCard(page).getByText(/Subagent .*Tool approval/)).toBeVisible({
			timeout: 60_000,
		});
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();

		// Approving lets the child run to completion: its file lands and its
		// output streams into the subagent card, not the parent transcript.
		// (The expand button's name carries the roster's live title, so it
		// is matched by prefix — the paired title gains a suffix.)
		await expect(page.getByText("Inspect the repo").first()).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: /Expand Inspect the repo/ }).click();
		// Scoped to the transcript: the subagent is also a sidebar row now, and
		// opencode may title it from the same reply.
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Child done.").first()
		).toBeVisible({ timeout: 60_000 });
		expect(existsSync(join(m.workspace, "child.txt"))).toBe(true);
	});

	test("sidebar: a subagent is listed under its workspace, marked, and its wait shows on both rows", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario(subagentApprovalScenario(m.workspace));
		await send(page, "delegate this");
		await allowTheSpawn(page);
		await expect(transcriptCard(page).getByText(/Subagent .*Tool approval/)).toBeVisible({
			timeout: 60_000,
		});

		// The sidebar polls: the child shows up as its own row, badged, with
		// where it came from, and waiting (the loud state) on it and its parent.
		const badge = page.getByTestId("subagent-badge");
		await expect(badge).toHaveCount(1, { timeout: 30_000 });
		const from = page.getByTestId("subagent-from");
		await expect(from).toContainText("↳ from");
		await expect(page.getByTestId("waiting-approval")).toHaveCount(2, { timeout: 30_000 });
		await expect(page.getByTestId("subagent-count")).toContainText("1 subagent");

		// The count's popover links to the child; its view says whose it is.
		await page.getByTestId("subagent-count").click();
		await page.getByRole("menuitem").first().click();
		await expect(page).toHaveURL(/agent=/);
		await expect(page.getByTestId("subagent-of")).toContainText("Subagent of");

		// "from" goes back to the parent, which is not a subagent.
		await from.click();
		await expect(page.getByTestId("subagent-of")).toHaveCount(0);

		// The filter hides subagent rows, and says so on reload.
		await page.getByRole("button", { name: "Show subagents" }).click();
		await expect(badge).toHaveCount(0);
		await page.reload();
		await expect(page.getByRole("button", { name: "Show subagents" })).toHaveAttribute(
			"aria-pressed",
			"false",
			{ timeout: 30_000 }
		);
		await expect(badge).toHaveCount(0);
		await page.getByRole("button", { name: "Show subagents" }).click();
		await expect(badge).toHaveCount(1);

		// Unblock the child so the turn ends cleanly.
		await transcriptCard(page).getByRole("button", { name: "Allow once" }).click();
		await expect(page.getByTestId("waiting-approval")).toHaveCount(0, { timeout: 60_000 });
	});

	test("subagent approvals: with the root on Allow, the spawn needs no card and only the child's first turn asks, once", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		// bash is left uncapped, so Allow reaches it. Even so the child's FIRST
		// turn asks: opencode starts a subagent before Cerea can hand it the
		// session's setting (PROTOCOL.md; the card says "New subagent · first
		// turn asks"). The parent's own `task` call is not a card under Allow.
		const m = await openSession(page, db, session.sessionId, {
			permission: { max: { session_spawn: "ask" } },
		});
		await choose(page, "Allow");
		await mockOpenAI.setDefaultScenario(subagentApprovalScenario(m.workspace));
		await send(page, "delegate this");

		const card = transcriptCard(page);
		await expect(card.getByText(/Subagent .*Tool approval/)).toBeVisible({ timeout: 60_000 });
		await expect(card.getByText("New subagent · first turn asks")).toBeVisible();
		// The one card is the child's bash, not the parent's spawn.
		await expect(card.locator("code").filter({ hasText: /^task$/ })).toHaveCount(0);
		await card.getByRole("button", { name: "Allow once" }).click();

		await expect(page.getByText("Inspect the repo").first()).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: /Expand Inspect the repo/ }).click();
		// Scoped to the transcript: the subagent is also a sidebar row now, and
		// opencode may title it from the same reply.
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Child done.").first()
		).toBeVisible({ timeout: 60_000 });
		// Nothing else asked: the one approval above was the whole of it.
		await expect(page.getByText("wants to call")).toHaveCount(0);
		expect(existsSync(join(m.workspace, "child.txt"))).toBe(true);
	});

	test("subagents: a task call renders as a subagent card in the parent transcript", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_task",
					name: "task",
					arguments: JSON.stringify({
						description: "Inspect the repo",
						prompt: "List what is in the repo.",
						subagent_type: "general",
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Subagent", " done", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "delegate this");
		await allowTheSpawn(page);
		await expect(page.getByText("Inspect the repo").first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Subagent done.").first()).toBeVisible({ timeout: 60_000 });

		// Expanding the card loads the child session's own transcript through the
		// machine: its first message is the prompt the parent's task call gave it.
		await page.getByRole("button", { name: "Expand Inspect the repo" }).click();
		await expect(page.getByText("List what is in the repo.")).toBeVisible({ timeout: 30_000 });
	});

	test("questions: opencode's own question tool becomes the SAME card as chat's ask_user_question, and the turn resumes once answered", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_q",
					name: "question",
					arguments: JSON.stringify({
						questions: [
							{
								question: "Which approach?",
								header: "Approach",
								options: [
									{ label: "A", description: "Do A" },
									{ label: "B", description: "Do B" },
								],
								multiple: false,
							},
						],
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Thanks", " for", " answering."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "ask me something");

		await expect(page.getByText("Which approach?")).toBeVisible({ timeout: 60_000 });
		// opencode tells the model a typed answer is always possible, so the card offers one.
		await expect(page.getByRole("button", { name: /Something else/ })).toHaveCount(1);
		// The option row's accessible name is its whole content ("A" plus its
		// description), so match on the description to pick the right one.
		await page.getByRole("button").filter({ hasText: "Do A" }).click();
		await page.getByRole("button", { name: "Send", exact: true }).click();

		await expect(page.getByText("Thanks for answering.")).toBeVisible({ timeout: 60_000 });
		// The tool call itself settles rather than hanging pending forever.
		await expect(page.getByText("wants to call")).toHaveCount(0);
		// It collapses to what was asked and chosen, not the "server" (it read
		// "Answered pystino" for every question).
		await expect(page.getByText("Approach → A").first()).toBeVisible();
		await expect(page.getByText(/Answered\s*pystino/i)).toHaveCount(0);
		await page.reload();
		await expect(page.getByText("Approach → A").first()).toBeVisible({ timeout: 30_000 });
	});

	test("questions: an ask pending across a reload is still answerable, and collapses to what was chosen before and after reload", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		// A real model sends the tool call alone, then answers in a new step
		// once the tool result is back: script exactly that.
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_q",
					name: "question",
					arguments: JSON.stringify({
						questions: [
							{
								question: "Which approach?",
								header: "Approach",
								options: [
									{ label: "A", description: "Do A" },
									{ label: "B", description: "Do B" },
								],
								multiple: false,
							},
						],
					}),
				},
			],
			toolCallsOnce: true,
			content: [],
			finishReason: "tool_calls",
			routes: [
				{
					contains: '"role":"tool"',
					scenario: { content: ["Went", " with", " A."], chunkDelayMs: 10, finishReason: "stop" },
				},
			],
		});
		await send(page, "ask me something");
		await expect(page.getByText("Which approach?")).toBeVisible({ timeout: 60_000 });
		// Reload while it waits: the ask comes back from the machine's snapshot
		// (question.asked is not replayed), and is answered from there.
		await page.reload();
		await expect(page.getByText("Which approach?")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button").filter({ hasText: "Do A" }).click();
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Went with A.")
		).toBeVisible({ timeout: 60_000 });
		const transcript = page.locator('[data-message-role="assistant"]');
		await expect(transcript.getByText("Approach → A").first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/Answered\s*pystino/i)).toHaveCount(0);
		await page.reload();
		await expect(transcript.getByText("Went with A.")).toBeVisible({ timeout: 30_000 });
		await expect(transcript.getByText("Approach → A").first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/Answered\s*pystino/i)).toHaveCount(0);
	});

	test("questions: a typed answer reaches the model through opencode verbatim", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_q",
					name: "question",
					arguments: JSON.stringify({
						questions: [
							{
								question: "Which approach?",
								header: "Approach",
								options: [
									{ label: "A", description: "Do A" },
									{ label: "B", description: "Do B" },
								],
							},
						],
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Doing", " C."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "ask me something");

		await expect(page.getByText("Which approach?")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: /Something else/ }).click();
		await page.getByRole("textbox", { name: "Your own answer" }).fill("Neither, do C");
		await page.getByRole("button", { name: "Send", exact: true }).click();

		await expect(page.getByText("Doing C.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Approach → Other: Neither, do C").first()).toBeVisible();
		// The typed text reaches the model through opencode's own tool result, on
		// the follow-up request opencode makes after the answer (the scripted reply
		// streams alongside the tool call, so it can show before that request).
		await expect
			.poll(
				async () =>
					(await mockOpenAI.requests()).some((r) => {
						const body = JSON.stringify(r.body);
						return body.includes("Neither, do C") && body.includes("Which approach?");
					}),
				{ timeout: 30_000 }
			)
			.toBe(true);
	});
});
