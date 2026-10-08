/**
 * Scheduled actions in /code, hermetic: a `FakeMachine` on the running app's
 * machine link (the terminal spec's setup), so what a run did is read off the
 * ops the machine received. The path a person takes: a session's ⋯ menu →
 * "Schedule this…" → the editor prefilled → create → Run now → the history.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine, type FakeMachineOptions } from "./fake-machine";

async function connectFakeMachine(
	sub: string,
	name: string,
	options: FakeMachineOptions = {}
): Promise<FakeMachine> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: token } = (await res.json()) as { access_token: string };
	const fake = new FakeMachine(
		`${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ policy: { workspaceRoots: [], allowFreeModels: false }, ...options }
	);
	await fake.hello();
	return fake;
}

/** Pair the machine, add a workspace and start one session, through the tree. */
async function pairAndStartSession(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this machine" }).click();
	await page.getByRole("button", { name: "Add a workspace to this device" }).click();
	await page.getByLabel("Directory on the machine").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByText("repo", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
	await page.getByRole("button", { name: "Build" }).click();
	await page.getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

const ops = (fake: FakeMachine, op: string) => fake.opLog.filter((o) => o.op === op);

async function horizontalOverflow(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[document.documentElement, ...document.querySelectorAll<HTMLElement>("body *")]
			.filter((el) => {
				const style = getComputedStyle(el);
				const scrolls = el === document.documentElement || /auto|scroll/.test(style.overflowX);
				return scrolls && el.scrollWidth > el.clientWidth + 1;
			})
			.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`)
	);
}

test.describe("scheduled actions, hermetic", () => {
	let fake: FakeMachine | null = null;
	test.afterEach(() => {
		fake?.close();
		fake = null;
	});

	test("schedule a session from its menu, run it now, read the history", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `sched-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		// The ⋯ menu of the session row.
		const sessionRow = page
			.locator('a[href*="&agent="]')
			.first()
			.locator("xpath=ancestor::div[contains(@class,'group')][1]");
		await sessionRow.hover();
		await sessionRow.getByRole("button", { name: "Session actions" }).click();
		await page.getByRole("menuitem", { name: "Schedule this…" }).click();

		// The editor opens with machine, workspace and session prefilled.
		const editor = page.getByTestId("schedule-editor");
		await expect(editor).toBeVisible();
		await expect(editor.getByLabel("1. Machine")).toHaveValue(/.+/);
		await expect(editor.getByLabel("1. Machine").locator("option:checked")).toContainText(name);
		await expect(editor.getByLabel("2. Workspace").locator("option:checked")).toHaveText("repo");
		const sessionSelect = editor.getByLabel("3. Session");
		await expect(sessionSelect.locator("option:checked")).not.toHaveText("A new session each run");
		// …and this time the person wants a fresh session each run.
		await sessionSelect.selectOption({ label: "A new session each run" });

		await editor.getByLabel("Name").fill("Nightly suite");
		await editor.getByLabel("Agent mode").selectOption("build");
		await editor.getByRole("radio", { name: "Allow" }).click();
		await editor.getByLabel("Prompt").fill("Run the suite and summarise failures.");
		await editor.getByLabel("Repeats").selectOption("hours");
		await editor.getByLabel("Every how many hours").fill("6");

		// The preview lists the next three runs, and refuses what is too fast.
		await expect(page.getByTestId("schedule-preview").locator("li")).toHaveCount(3);
		await editor.getByLabel("Repeats").selectOption("cron");
		await editor.getByLabel("Cron expression").fill("*/5 * * * *");
		await expect(page.getByTestId("preview-error")).toContainText("15 minutes");
		await editor.getByLabel("Repeats").selectOption("weekdays");
		await editor.getByLabel("At", { exact: true }).fill("09:30");
		await expect(page.getByTestId("schedule-preview").locator("li")).toHaveCount(3);

		await editor.getByRole("button", { name: "Create schedule" }).click();

		// The list names where it runs and when.
		const row = page.getByTestId("schedule-row").filter({ hasText: "Nightly suite" });
		await expect(row).toBeVisible();
		await expect(row.getByTestId("schedule-target")).toHaveText(`${name} › repo › new session`);
		await expect(row.getByTestId("next-run")).not.toHaveText("—");

		// Run now: a new session on the machine, the chosen word applied, then the prompt.
		const sessionsBefore = fake.model.sessions.length;
		await row.getByRole("button", { name: "Run now" }).click();
		await expect(row.getByTestId("run-notice")).toContainText("Sent");
		expect(fake.model.sessions.length).toBe(sessionsBefore + 1);
		const created = fake.model.sessions[fake.model.sessions.length - 1];
		expect(created.title).toMatch(/^Nightly suite · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(created.permissionMode).toBe("allow");
		expect(created.modeId).toBe("build");
		const prompts = ops(fake, "session.prompt").filter(
			(o) => (o.args as { sessionId: string }).sessionId === created.id
		);
		expect(prompts).toHaveLength(1);
		expect((prompts[0].args as { text: string }).text).toMatch(
			/^\[Scheduled run of "[^\]]*", .*; coordination: none\]\n\nRun the suite and summarise failures\.$/
		);
		expect(ops(fake, "session.setPermissionMode").pop()?.args).toEqual({
			sessionId: created.id,
			mode: "allow",
		});

		// The history shows the run, with a link into its session.
		await row.getByRole("link", { name: "History" }).click();
		const history = page.getByTestId("run-row");
		await expect(history).toHaveCount(1);
		await expect(history.first()).toContainText("Sent");
		await expect(history.first().getByRole("link", { name: /Open session/ })).toHaveAttribute(
			"href",
			new RegExp(`agent=${created.id}`)
		);

		// The session the schedule started carries the schedule's marker in the tree.
		await page.goto(`${E2E_APP_BASE}/code?view=schedules`);
		await expect(page.getByTestId("scheduled-badge").first()).toBeAttached();
	});

	test("an agent creates a schedule over the machine link, it shows as the agent's, then pauses itself", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `sched-agent-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		expect(fake.features).toEqual({ machineCalls: ["schedule"] });
		await pairAndStartSession(page, name);
		const agent = fake.model.sessions[0];
		agent.title = "Refactor the parser";

		const created = await fake.call(
			"schedule.create",
			{
				name: "Check CI after the refactor",
				prompt: "See whether CI is green on main and fix it if not.",
				recurrence: { type: "weekdays", at: "08:00" },
				timezone: "Europe/Rome",
				session: "this",
				permissionMode: "ask",
			},
			{ sessionId: agent.id, caller: { workspaceId: agent.workspaceId, permissionMode: "ask" } }
		);
		expect(created.ok).toBe(true);
		const id = created.ok ? (created.result as { schedule: { id: string } }).schedule.id : "";

		await page.goto(`${E2E_APP_BASE}/code?view=schedules`);
		const row = page.getByTestId("schedule-row").filter({ hasText: "Check CI after the refactor" });
		await expect(row.getByTestId("schedule-target")).toHaveText(
			`${name} › repo › Refactor the parser`
		);
		const tag = row.getByTestId("schedule-created-by");
		await expect(tag).toHaveText("Created by an agent in Refactor the parser");
		await expect(tag.getByRole("link")).toHaveAttribute(
			"href",
			new RegExp(`device=${fake.deviceId}&ws=${agent.workspaceId}&agent=${agent.id}`)
		);
		await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");

		// The editor carries the same line.
		await row.getByRole("link", { name: "Edit" }).click();
		await expect(page.getByTestId("schedule-editor").getByTestId("schedule-created-by")).toHaveText(
			"Created by an agent in Refactor the parser"
		);

		// Done: the agent pauses its own schedule, and the list shows it off.
		const paused = await fake.call(
			"schedule.update",
			{ id, paused: true },
			{ sessionId: agent.id }
		);
		expect(paused.ok).toBe(true);
		await page.goto(`${E2E_APP_BASE}/code?view=schedules`);
		await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
		await expect(row.getByTestId("next-run")).toHaveText("Off");
		const audit = await db
			.collection("codeAudit")
			.find({ scheduleId: id })
			.project({ action: 1, sessionId: 1, _id: 0 })
			.toArray();
		expect(audit).toEqual([
			{ action: "schedule.create", sessionId: agent.id },
			{ action: "schedule.update", sessionId: agent.id },
		]);
	});

	test("a new workspace is made on save, and the machine's refusal is shown inline", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `sched-ws-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		await page.goto(`${E2E_APP_BASE}/code?view=schedules&new=1`);
		const editor = page.getByTestId("schedule-editor");
		await editor.getByLabel("1. Machine").selectOption({ label: `${name} · online` });
		await expect(
			editor.getByLabel("2. Workspace").locator("option", { hasText: "repo" })
		).toBeAttached();
		await editor.getByLabel("2. Workspace").selectOption({ label: "New workspace…" });
		await editor.getByLabel("Name").fill("Fresh checkout");
		await editor.getByLabel("Prompt").fill("pull and build");
		await editor.getByLabel("Directory on the machine").fill("/outside/roots");

		// The machine refuses (workspaceRoots): nothing is saved, the reason is inline.
		fake.onOp("workspace.create", () => {
			throw Object.assign(new Error("that directory is outside this machine's workspace roots"), {
				code: "forbidden",
			});
		});
		await editor.getByRole("button", { name: "Create schedule" }).click();
		await expect(page.getByRole("alert")).toContainText("workspace roots");
		expect(await db.collection("schedules").countDocuments({})).toBe(0);

		// Accepted: the workspace is created first, then the schedule points at it.
		fake.onOp("workspace.create", (args) => {
			const { path, title } = args as { path: string; title?: string };
			const workspace = {
				id: "ws-created",
				name: title ?? "created",
				path,
				createdAt: new Date().toISOString(),
				isGitRepo: false,
			};
			fake?.model.workspaces.push(workspace);
			return { workspace };
		});
		await editor.getByLabel("Directory on the machine").fill("/work/fresh");
		await editor.getByLabel("Title (optional)").fill("fresh");
		await editor.getByRole("button", { name: "Create schedule" }).click();
		const row = page.getByTestId("schedule-row").filter({ hasText: "Fresh checkout" });
		await expect(row.getByTestId("schedule-target")).toHaveText(`${name} › fresh › new session`);
		const stored = await db.collection("schedules").findOne({ name: "Fresh checkout" });
		expect(stored?.target.workspaceId).toBe("ws-created");
	});

	test("Ask is explained next to the selector, and Allow is capped by the machine", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		fake = await connectFakeMachine(sub, `sched-ask-${randomUUID().slice(0, 6)}`);
		await page.goto(`${E2E_APP_BASE}/code?view=schedules&new=1`);
		const editor = page.getByTestId("schedule-editor");
		await expect(editor.getByTestId("ask-warning")).toContainText("Needs-you inbox");
		await editor.getByRole("radio", { name: "Allow" }).click();
		await expect(editor.getByTestId("ask-warning")).toHaveCount(0);
		await expect(editor).toContainText("never past the machine's own ceiling");
	});

	/** Fill the editor for a fresh schedule on the machine's one workspace. */
	async function newScheduleOn(page: Page, name: string, scheduleName: string) {
		await page.goto(`${E2E_APP_BASE}/code?view=schedules&new=1`);
		const editor = page.getByTestId("schedule-editor");
		await editor.getByLabel("1. Machine").selectOption({ label: `${name} · online` });
		await expect(
			editor.getByLabel("2. Workspace").locator("option", { hasText: "repo" })
		).toBeAttached();
		await editor.getByLabel("2. Workspace").selectOption({ label: "repo" });
		await editor.getByLabel("Name").fill(scheduleName);
		await editor.getByLabel("Prompt").fill("Check on the other sessions and report.");
		return editor;
	}

	test("the coordination options are off by default, and a run grants them before its prompt", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `coord-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		const editor = await newScheduleOn(page, name, "Orchestrator");
		await expect(editor.getByLabel("Can find, read and message other sessions")).not.toBeChecked();
		await expect(editor.getByLabel("Can start new sessions")).not.toBeChecked();
		// This machine can take a grant and caps nothing: no warning.
		await expect(editor.getByTestId("coordination-unsupported")).toHaveCount(0);
		await expect(editor.getByTestId("coordination-ceiling")).toHaveCount(0);

		await editor.getByLabel("Can find, read and message other sessions").check();
		await editor.getByLabel("Can start new sessions").check();
		await editor.getByRole("button", { name: "Create schedule" }).click();
		const row = page.getByTestId("schedule-row").filter({ hasText: "Orchestrator" });
		await expect(row).toBeVisible();
		const stored = await db.collection("schedules").findOne({ name: "Orchestrator" });
		expect(stored?.target).toMatchObject({ canMessage: true, canSpawn: true });

		await row.getByRole("button", { name: "Run now" }).click();
		await expect(row.getByTestId("run-notice")).toContainText("Sent");

		const created = fake.model.sessions[fake.model.sessions.length - 1];
		expect(fake.model.coordination.get(created.id)).toEqual([
			"session_list",
			"session_read",
			"session_send",
			"session_spawn",
		]);
		const order = fake.opLog.map((o) => o.op);
		expect(order.lastIndexOf("session.grantCoordination")).toBeLessThan(
			order.lastIndexOf("session.prompt")
		);
		expect(order.lastIndexOf("session.grantCoordination")).toBeGreaterThan(
			order.lastIndexOf("session.create")
		);

		await row.getByRole("link", { name: "History" }).click();
		await expect(page.getByTestId("run-row").first()).toContainText(
			"find, read and message other sessions"
		);
	});

	test("an old galopin: the editor warns, and the run goes ahead without the grant", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `old-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name, { coordinationGrant: false });
		await pairAndStartSession(page, name);

		const editor = await newScheduleOn(page, name, "Old machine");
		await expect(editor.getByTestId("coordination-unsupported")).toContainText(
			"galopin is too old to grant coordination; update it"
		);
		await editor.getByLabel("Can find, read and message other sessions").check();
		await editor.getByRole("button", { name: "Create schedule" }).click();

		const row = page.getByTestId("schedule-row").filter({ hasText: "Old machine" });
		await row.getByRole("button", { name: "Run now" }).click();
		await expect(row.getByTestId("run-notice")).toContainText("Sent");
		expect(ops(fake, "session.grantCoordination")).toHaveLength(0);
		const created = fake.model.sessions[fake.model.sessions.length - 1];
		expect(
			ops(fake, "session.prompt").filter(
				(o) => (o.args as { sessionId: string }).sessionId === created.id
			)
		).toHaveLength(1);
		expect(fake.model.coordination.size).toBe(0);

		await row.getByRole("link", { name: "History" }).click();
		await expect(page.getByTestId("run-row").first()).toContainText(
			"this machine's galopin is too old to grant coordination; update it"
		);
	});

	test("the editor says what the machine's ceiling still holds at Ask", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `ceil-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name, {
			policy: {
				workspaceRoots: [],
				allowFreeModels: false,
				permission: { max: { session_send: "ask", session_spawn: "ask" } },
			},
		});
		await pairAndStartSession(page, name);

		const editor = await newScheduleOn(page, name, "Capped");
		await expect(editor.getByTestId("coordination-ceiling")).toHaveCount(0);
		await editor.getByLabel("Can find, read and message other sessions").check();
		await expect(editor.getByTestId("coordination-ceiling")).toContainText(
			"messaging sessions at Ask"
		);
		await expect(editor.getByTestId("coordination-ceiling")).toContainText("Needs-you inbox");
	});

	test("the list, the editor and the history fit a phone", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		const userId = await seedUser(db, session.sessionId, sub);
		const name = `phone-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);
		const device = await db.collection("codeDevices").findOne({ userId });
		const created = await db.collection("schedules").insertOne({
			userId,
			kind: "agent",
			name: "A schedule whose name is long enough to need wrapping on a very small screen indeed",
			target: {
				deviceId: String(device?._id),
				workspaceId: "ws-x",
				sessionMode: "new",
				permissionMode: "ask",
				labels: { machine: name, workspace: "a-very-long-workspace-directory-name-with-no-spaces" },
			},
			prompt: "p",
			recurrence: { type: "cron", expr: "0 9 * * 1-5" },
			timezone: "America/Argentina/ComodRivadavia",
			anchorAt: new Date(),
			enabled: true,
			nextRunAt: new Date(Date.now() + 3600e3),
			consecutiveFailures: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await db.collection("scheduleRuns").insertOne({
			scheduleId: created.insertedId,
			userId,
			kind: "agent",
			scheduledFor: new Date(),
			firedAt: new Date(),
			status: "failed",
			trigger: "schedule",
			detail:
				"The workspace “a-very-long-workspace-directory-name-with-no-spaces” no longer exists on the machine.",
			scheduleName: "x",
		} as never);

		await page.setViewportSize({ width: 390, height: 1300 });
		for (const path of [
			"?view=schedules",
			`?view=schedules&schedule=${created.insertedId}`,
			`?view=schedules&schedule=${created.insertedId}&edit=1`,
			"?view=schedules&new=1",
		]) {
			await page.goto(`${E2E_APP_BASE}/code${path}`);
			await expect(
				page.locator(
					'[data-testid="schedules-list"], [data-testid="schedule-history"], [data-testid="schedule-editor"]'
				)
			).toBeVisible();
			await page.waitForTimeout(400);
			expect(await horizontalOverflow(page), path).toEqual([]);
		}
	});
});
