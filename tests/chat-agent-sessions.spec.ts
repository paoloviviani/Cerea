/**
 * The chat drives coding-agent sessions (ADR 0106), against a REAL machine: the chain is a chat
 * turn on the Cerea server (an `agent_*` tool) -> the machine's existing WSS (MachineLink) ->
 * the real `galopin` -> a real `opencode serve`. Only the LLMs and the IdP are mocked.
 *
 * Both models are the same mock upstream: the chat turn asks it with a `chatui-conversation-id`
 * header (scripted per conversation, one tool call per user turn), opencode asks it without one
 * (the default scenario: a plain answer). That is how one mock plays the chat model and the
 * machine's model apart.
 *
 * One test, one machine: pairing a machine is the slow part, and the steps depend on each
 * other (the session started in step 1 is read in step 2 and prompted in step 3).
 */
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import superjson from "superjson";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, type MockOpenAIControl } from "./fixtures";
import type { ScenarioSelector } from "./mock-openai";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

/** What the machine's own model (opencode, through the mock) answers. */
const MACHINE_ANSWER = "Machine answer from the real opencode.";
const FIRST_PROMPT = "Add a changelog entry for the e2e run";
const SECOND_PROMPT = "Now also mention the second prompt";

interface CodeAgent {
	id: string;
	title: string;
	state: string;
	permissionMode?: "deny" | "ask" | "allow";
}

test.describe("chat drives agent sessions: real machine", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ timeout: 360_000 });

	let machine: Machine | null = null;

	test.afterEach(async () => {
		await machine?.stop();
		machine = null;
	});

	test("start, read, prompt, refusals and the card, through a project's chat", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		const userId = await seedUser(db, session.sessionId, sub);
		// Every acting tool asks first: the card is part of what is proven.
		await db
			.collection("settings")
			.updateOne({ userId }, { $set: { toolApprovalPolicy: "manual" } });
		// opencode's own model: no conversation header, so the default scenario.
		await mockOpenAI.setDefaultScenario({
			content: MACHINE_ANSWER.split(/(?<= )/),
			chunkDelayMs: 10,
			finishReason: "stop",
		});

		// -- Pair a real machine and add its repo as a workspace (the /code UI, as the parity spec). --
		const started = await startMachine({ sub });
		machine = started;
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(started.name)).toBeVisible({ timeout: 90_000 });
		await page.getByRole("button", { name: "Confirm this computer" }).click();
		await page.getByRole("button", { name: "Add a workspace to this computer" }).click();
		await page.getByLabel("Directory on the computer").fill(started.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(
			page.getByRole("button", { name: "Start a session in this workspace" })
		).toBeVisible({ timeout: 30_000 });

		const device = await db.collection("codeDevices").findOne({ name: started.name });
		if (!device) throw new Error("the machine did not pair");
		const deviceId = String(device._id);
		/** A /code API read: its bodies are superjson. */
		const codeGet = async <T>(path: string): Promise<T> => {
			const res = await page.request.get(`${E2E_APP_URL}/api/v2/code/${path}`);
			return superjson.parse<T>(await res.text());
		};
		const listWorkspaces = async () =>
			(
				await codeGet<{ workspaces: { id: string; name: string }[] }>(
					`v1/workspaces?device=${deviceId}`
				)
			).workspaces ?? [];
		await expect.poll(async () => (await listWorkspaces()).length, { timeout: 30_000 }).toBe(1);
		const workspaceId = (await listWorkspaces())[0].id;
		const agents = async (): Promise<CodeAgent[]> =>
			(await codeGet<{ agents: CodeAgent[] }>(`v1/agents?device=${deviceId}`)).agents ?? [];
		const agentNamed = async (title: string) => (await agents()).find((a) => a.title === title);

		// -- A project with an agent profile on that machine + workspace, permission Allow. --
		const projectRes = await page.request.post(`${E2E_APP_URL}/api/v2/projects`, {
			headers: { origin: E2E_APP_URL },
			data: { name: "Agents project" },
		});
		expect(projectRes.ok()).toBe(true);
		const { id: projectId } = (await projectRes.json()) as { id: string };
		expect(projectId).toBeTruthy();
		const putProfile = async (permissionMode: "ask" | "allow") => {
			const res = await page.request.put(
				`${E2E_APP_URL}/api/v2/projects/${projectId}/agent-profile`,
				{ headers: { origin: E2E_APP_URL }, data: { deviceId, workspaceId, permissionMode } }
			);
			expect(res.ok(), await res.text()).toBe(true);
			return (await res.json()) as { permissionMode: string; labels: { device: string } };
		};
		expect((await putProfile("allow")).permissionMode).toBe("allow");

		// -- Chat helpers. --
		const newConversation = async (inProject: boolean): Promise<string> => {
			const res = await page.request.post(`${E2E_APP_URL}/conversation`, {
				headers: { origin: E2E_APP_URL, "content-type": "application/json" },
				data: { model: "test-org/test-model", ...(inProject ? { projectId } : {}) },
			});
			expect(res.ok(), await res.text()).toBe(true);
			return ((await res.json()) as { conversationId: string }).conversationId;
		};
		const assistant = (p: Page) => p.locator('[data-message-role="assistant"]');
		/** One user turn whose scripted model makes one tool call, then answers `answer`. */
		const turn = async (
			conversationId: string,
			tool: { name: string; args: Record<string, unknown> },
			answer: string,
			userText: string
		) => {
			await mockOpenAI.setScenario(conversationId, {
				toolCalls: [
					{
						id: `call_${randomUUID().slice(0, 8)}`,
						name: tool.name,
						arguments: JSON.stringify(tool.args),
					},
				],
				content: answer.split(/(?<= )/),
				chunkDelayMs: 10,
				finishReason: "stop",
			} satisfies ScenarioSelector);
			await page.getByPlaceholder("Ask anything").fill(userText);
			await page.getByRole("button", { name: "Send message" }).click();
		};
		/** The newest tool result the chat model was handed in this conversation. */
		const lastToolResult = async (conversationId: string, mock: MockOpenAIControl) => {
			const requests = (await mock.requests()).filter(
				(r) => r.path === "/v1/chat/completions" && r.conversationId === conversationId
			);
			for (const r of requests.toReversed()) {
				const messages = (r.body.messages ?? []) as { role: string; content: unknown }[];
				const tool = messages.findLast((m) => m.role === "tool");
				if (tool)
					return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
			}
			return "";
		};
		const approve = async (toolName: string) => {
			const last = assistant(page).last();
			await expect(last.getByText(`wants to call ${toolName}`)).toBeVisible({ timeout: 60_000 });
			await last.getByRole("button", { name: "Allow once" }).click();
		};

		// ===== a. In the project: agent_sessions, then agent_start with the profile's defaults. =====
		const conversationId = await newConversation(true);
		await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
		await turn(
			conversationId,
			{ name: "agent_sessions", args: {} },
			"I can see your machine.",
			"What machines do I have?"
		);
		await expect(assistant(page).last()).toContainText("I can see your machine.", {
			timeout: 60_000,
		});
		const listed = await lastToolResult(conversationId, mockOpenAI);
		// Outside content: header and footer around it (agent_sessions hardening).
		expect(listed).toContain("[Result of agent_sessions");
		expect(listed).toContain(started.name);
		expect(listed).toContain(workspaceId);
		expect(listed).toContain('"permissionMode":"allow"');
		// Nothing was gated or created yet.
		expect(await agents()).toHaveLength(0);

		await turn(
			conversationId,
			// No deviceId / workspaceId: the project's default fills them.
			{ name: "agent_start", args: { prompt: FIRST_PROMPT, title: "Changelog run" } },
			"Started the session.",
			"Start an agent on the changelog"
		);
		// The approval card comes first, and nothing exists on the machine until it is allowed.
		const turnTwo = assistant(page).last();
		await expect(turnTwo.getByText("wants to call agent_start")).toBeVisible({ timeout: 60_000 });
		expect(await agents()).toHaveLength(0);
		await turnTwo.getByRole("button", { name: "Allow once" }).click();
		await expect(turnTwo).toContainText("Started the session.", { timeout: 60_000 });

		// The session exists on the machine, in that workspace, with the profile's word.
		await expect
			.poll(async () => (await agentNamed("Changelog run"))?.permissionMode, {
				timeout: 30_000,
			})
			.toBe("allow");
		const created = await agentNamed("Changelog run");
		if (!created) throw new Error("the started session is not on the machine");
		expect(await agents()).toHaveLength(1);

		// The card: machine > workspace labels and a live state.
		const card = page.getByTestId("agent-session-card");
		await expect(card).toHaveCount(1);
		await expect(card.getByTestId("agent-session-route")).toHaveText(
			`Started · ${started.name} › repo`
		);
		await expect(card).toHaveAttribute("data-state", /^(checking|working|needs-you|idle)$/, {
			timeout: 30_000,
		});
		// b (part). The card's state settles: the real opencode answers and the session goes idle.
		await expect(card).toHaveAttribute("data-state", "idle", { timeout: 90_000 });

		// "Open in /code" lands on that session, under the profile's Allow.
		await card.getByRole("link", { name: /Open .* in \/code/ }).click();
		await expect(page).toHaveURL(
			new RegExp(`/code\\?device=${deviceId}&ws=.*&agent=${created.id}`)
		);
		await expect(
			page.getByRole("radiogroup", { name: "Permission for this session" }).getByRole("radio", {
				name: "Allow",
			})
		).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
		await expect(page.getByText(MACHINE_ANSWER).first()).toBeVisible({ timeout: 60_000 });

		// ===== b. agent_read returns the real opencode's last answer. =====
		await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
		await turn(
			conversationId,
			{ name: "agent_read", args: { deviceId, sessionId: created.id } },
			"Read it.",
			"What did the agent say?"
		);
		await expect(assistant(page).last()).toContainText("Read it.", { timeout: 60_000 });
		const read = await lastToolResult(conversationId, mockOpenAI);
		expect(read).toContain("[Result of agent_read");
		expect(read).toContain('"state":"idle"');
		expect(read).toContain(MACHINE_ANSWER);

		// ===== c. agent_send keeps the session's own word, not the profile's (now Ask). =====
		expect((await putProfile("ask")).permissionMode).toBe("ask");
		await turn(
			conversationId,
			{ name: "agent_send", args: { deviceId, sessionId: created.id, prompt: SECOND_PROMPT } },
			"Sent it.",
			"Tell it one more thing"
		);
		await approve("agent_send");
		await expect(assistant(page).last()).toContainText("Sent it.", { timeout: 60_000 });
		await expect(page.getByTestId("agent-session-card").last()).toHaveAttribute(
			"data-action",
			"prompted"
		);
		// The second prompt reached the real opencode...
		await expect
			.poll(
				async () =>
					(await mockOpenAI.requests()).some(
						(r) =>
							r.path === "/v1/chat/completions" &&
							r.conversationId === null &&
							JSON.stringify(r.body).includes(SECOND_PROMPT)
					),
				{ timeout: 60_000 }
			)
			.toBe(true);
		// ...and the session still has its own word, neither the profile's Ask nor a reset.
		await expect
			.poll(async () => (await agentNamed("Changelog run"))?.state, {
				timeout: 90_000,
			})
			.toBe("idle");
		expect((await agentNamed("Changelog run"))?.permissionMode).toBe("allow");
		expect(await agents()).toHaveLength(1);

		// ===== d. Outside the project, agent_start creates the session on Ask. =====
		const looseId = await newConversation(false);
		await page.goto(`${E2E_APP_BASE}/conversation/${looseId}`);
		await turn(
			looseId,
			{
				name: "agent_start",
				args: { prompt: "Look around the repo", title: "Loose run", deviceId, workspaceId },
			},
			"Started the loose one.",
			"Start one outside the project"
		);
		await approve("agent_start");
		await expect(assistant(page).last()).toContainText("Started the loose one.", {
			timeout: 60_000,
		});
		await expect
			.poll(async () => (await agentNamed("Loose run"))?.permissionMode, {
				timeout: 30_000,
			})
			.toBe("ask");
		expect(await agents()).toHaveLength(2);

		// ===== e. Refusals. =====
		// A device that is not the user's: refused as if it did not exist, nothing created.
		const otherUser = new ObjectId();
		const otherDevice = new ObjectId();
		await db.collection("codeDevices").insertOne({
			_id: otherDevice,
			userId: otherUser,
			machineId: `other-${randomUUID()}`,
			name: "someone-elses-box",
			status: "paired",
			sub: "other",
			iss: "other",
			backends: [],
			policy: {},
			credentialState: "ok",
			createdAt: new Date(),
		});
		await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
		await turn(
			conversationId,
			{
				name: "agent_start",
				args: { prompt: "Sneak in", deviceId: String(otherDevice), workspaceId },
			},
			"That did not work.",
			"Start one on a stranger's machine"
		);
		await approve("agent_start");
		await expect(assistant(page).last()).toContainText("That did not work.", { timeout: 60_000 });
		expect(await lastToolResult(conversationId, mockOpenAI)).toContain("No such machine");
		expect(await agents()).toHaveLength(2);

		// An offline machine: a clear refusal, nothing sent.
		await started.stop();
		machine = null;
		await expect
			.poll(
				async () => {
					const body = await codeGet<{ devices?: { id: string; online: boolean }[] }>("devices");
					return body.devices?.find((d) => d.id === deviceId)?.online;
				},
				{ timeout: 60_000 }
			)
			.toBe(false);
		await turn(
			conversationId,
			{ name: "agent_start", args: { prompt: "Anyone there?" } },
			"It is offline.",
			"Try once more"
		);
		await approve("agent_start");
		await expect(assistant(page).last()).toContainText("It is offline.", { timeout: 60_000 });
		expect(await lastToolResult(conversationId, mockOpenAI)).toContain(
			`${started.name} is offline`
		);

		// The cards survive a reload, now offline, from the stored update alone.
		await page.reload();
		const cards = page.getByTestId("agent-session-card");
		await expect(cards).toHaveCount(2, { timeout: 60_000 });
		await expect(cards.first().getByTestId("agent-session-route")).toHaveText(
			`Started · ${started.name} › repo`
		);
		await expect(cards.first()).toHaveAttribute("data-state", "offline", { timeout: 60_000 });
		await expect(cards.first().getByTestId("agent-session-offline")).toBeVisible();
	});
});
