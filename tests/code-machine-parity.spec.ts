/**
 * Parity milestones against a real machine (the same chain as the P0 spec: the real
 * `galopin` supervising a real `opencode serve`, only the LLM and the IdP mocked).
 * Each test pairs its own machine, so a policy set for one never leaks into another.
 */
import { existsSync, writeFileSync } from "node:fs";
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
		await page.getByRole("button", { name: "Write" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByRole("combobox")).toBeEnabled({ timeout: 30_000 });
		return started;
	}

	async function send(page: Page, text: string): Promise<void> {
		await page.getByRole("combobox").fill(text);
		await page.getByRole("button", { name: "Send message" }).click();
	}

	const writeFileScenario = {
		toolCalls: [
			{
				id: "call_w",
				name: "bash",
				arguments: JSON.stringify({ command: "echo parity > out.txt", description: "write" }),
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

	test("auto-accept: visible but disabled under the default policy, with the re-enroll fix", async ({
		page,
		db,
		session,
	}) => {
		await openSession(page, db, session.sessionId);
		const pill = page.getByRole("button", { name: /auto.?accept/i });
		await expect(pill).toBeVisible();
		await expect(pill).toBeDisabled();
		await expect(page.getByText(/--allow-auto-accept/)).toBeVisible();
	});

	test("approvals: Always allow grants the rest of the session, so a later call needs no second prompt", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);

		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_a",
					name: "bash",
					arguments: JSON.stringify({ command: "echo one > a.txt", description: "write a" }),
				},
			],
			toolCallsOnce: true,
			content: ["First", " done", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "write a");
		await expect(page.getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Always allow" }).click();
		await expect(page.getByText("First done.")).toBeVisible({ timeout: 60_000 });

		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_b",
					name: "bash",
					arguments: JSON.stringify({ command: "echo two > b.txt", description: "write b" }),
				},
			],
			toolCallsOnce: true,
			content: ["Second", " done", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "write b");
		await expect(page.getByText("Second done.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);
	});

	test("auto-accept: a machine that allows it runs tools without asking, and the diff shows the change", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId, { autoAccept: "allowed" });
		await page.getByRole("button", { name: /auto.?accept/i }).click();
		await mockOpenAI.setDefaultScenario(writeFileScenario);
		await send(page, "write the file");
		await expect(page.getByText("Wrote it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(true);

		await page.getByRole("button", { name: "Changes" }).click();
		await expect(page.getByText("out.txt").first()).toBeVisible({ timeout: 20_000 });
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

		// The card arrives mid-turn (the turn is still held on it), labelled
		// as the subagent's — a parent's own ask never says "Subagent".
		await expect(page.getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/Subagent/).first()).toBeVisible({ timeout: 30_000 });
		await page.getByRole("button", { name: "Allow once" }).click();

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
		await expect(page.getByText("wants to call")).toBeVisible({ timeout: 60_000 });

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
		await page.getByRole("button", { name: "Allow once" }).click();
		await expect(page.getByTestId("waiting-approval")).toHaveCount(0, { timeout: 60_000 });
	});

	test("subagent approvals: with auto-accept on, a child's tools run without asking", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId, { autoAccept: "allowed" });
		await page.getByRole("button", { name: /auto.?accept/i }).click();
		await mockOpenAI.setDefaultScenario(subagentApprovalScenario(m.workspace));
		await send(page, "delegate this");

		await expect(page.getByText("Inspect the repo").first()).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: /Expand Inspect the repo/ }).click();
		// Scoped to the transcript: the subagent is also a sidebar row now, and
		// opencode may title it from the same reply.
		await expect(
			page.locator('[data-message-role="assistant"]').getByText("Child done.").first()
		).toBeVisible({ timeout: 60_000 });
		const html = await page.content();
		console.log(
			"DEBUG wants-to-call contexts:",
			(html.match(/.{120}wants to call.{120}/gs) ?? []).join("\n---\n")
		);
		for (const r of await mockOpenAI.requests()) {
			const msgs = ((r.body as { messages?: Array<{ role?: string }> }).messages ?? []).filter(
				(m) => m.role === "tool"
			);
			for (const m of msgs) console.log("DEBUG tool message:", JSON.stringify(m).slice(0, 2000));
		}
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
