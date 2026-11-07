import type { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { codeAgentsAllowedFor, codeAgentsEnabled } from "$lib/server/codeEnabled";
import { projectForMember } from "$lib/server/projects";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";
import {
	AgentStepError,
	busyReason,
	checkOwnedTarget,
	sendPrompt,
	sessionState,
	startAgentSession,
	workspaceNameOn,
} from "$lib/server/code/agentSessions";
import { authTimeFresh, sessionAuthFresh } from "$lib/server/code/stepUp";
import { getProjectAgentProfile, profileView } from "$lib/server/projectAgentProfiles";
import { setSessionConnectorKeys } from "$lib/server/code/sessionConnectors";
import { MessageUpdateType, type MessageAgentSessionUpdate } from "$lib/types/MessageUpdate";
import { OpError, type Part, type PermissionStep, type Session } from "$lib/types/machineProtocol";
import { autoClassesFor } from "$lib/server/agentReview";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type { ProjectAgentProfile } from "$lib/types/AgentSession";
import type { BuiltinTool, BuiltinToolResult } from "./types";

/**
 * The chat drives coding-agent sessions on the caller's own machines (ADR 0106): list them,
 * start one, send a prompt to one, read one. They go over the same `MachineLink` ops the /code
 * panel and scheduled agent runs use; the session-starting code is shared with the latter
 * (`code/agentSessions.ts`).
 *
 * - Not waiting: `agent_start` and `agent_send` return as soon as the prompt is accepted; the
 *   result is read later with `agent_read`.
 * - Only the caller's own machines: every id is resolved against the caller's devices, and any
 *   other id is refused as if it did not exist.
 * - `agent_start` and `agent_send` act, so they go through the approval policy (ADR 0075, gated
 *   in `toolInvocation.ts` and re-run on the click in `mcp/resumeElicitation.ts`); a scheduled
 *   run on Ask refuses them. Both entry points call `runAgentSessionTool`.
 * - `agent_read` returns text the agent wrote from repository content: untrusted
 *   (`textGeneration/untrusted.ts`).
 */
export const AGENT_SESSIONS_TOOL_NAME = "agent_sessions";
export const AGENT_START_TOOL_NAME = "agent_start";
export const AGENT_SEND_TOOL_NAME = "agent_send";
export const AGENT_READ_TOOL_NAME = "agent_read";
export type AgentSessionToolName =
	| typeof AGENT_SESSIONS_TOOL_NAME
	| typeof AGENT_START_TOOL_NAME
	| typeof AGENT_SEND_TOOL_NAME
	| typeof AGENT_READ_TOOL_NAME;

/** The tools that act on a machine: the ones the approval policy gates. */
export const AGENT_ACTING_TOOLS: ReadonlySet<string> = new Set([
	AGENT_START_TOOL_NAME,
	AGENT_SEND_TOOL_NAME,
]);
export const AGENT_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set([
	AGENT_SESSIONS_TOOL_NAME,
	AGENT_START_TOOL_NAME,
	AGENT_SEND_TOOL_NAME,
	AGENT_READ_TOOL_NAME,
]);

/** The bounds: what a prompt may carry, what a read returns, how much a list shows. */
export const MAX_AGENT_PROMPT_LENGTH = 20_000;
export const MAX_LAST_ANSWER_CHARS = 6_000;
export const MAX_TRANSCRIPT_CHARS = 30_000;
const TRANSCRIPT_MESSAGES = 200;
const MAX_LISTED_SESSIONS = 20;
const MAX_LISTED_MACHINES = 10;
const MAX_TITLE = 120;

export const SIGN_IN_REFUSAL =
	"The user's sign-in is older than 7 days, so machines cannot be driven from the chat until they sign in again " +
	"(the Agents page offers it). Tell them to sign in again and ask once more; do not retry.";

const idString = z.string().trim().min(1).max(256);
const promptString = z.string().trim().min(1).max(MAX_AGENT_PROMPT_LENGTH);

const startSchema = z.object({
	prompt: promptString,
	deviceId: idString.optional(),
	workspaceId: idString.optional(),
	title: z.string().trim().min(1).max(MAX_TITLE).optional(),
	modeId: idString.optional(),
	modelId: idString.optional(),
});
const sendSchema = z.object({ deviceId: idString, sessionId: idString, prompt: promptString });
const readSchema = z.object({
	deviceId: idString,
	sessionId: idString,
	full: z.boolean().optional(),
});

/** Who a call acts for. `sessionId` is the Cerea sign-in session the freshness rule reads. */
export interface AgentToolContext {
	userId: ObjectId | undefined;
	conversationId?: ObjectId;
	sessionId?: string;
}

type ToolOutcome = { text: string; extraUpdates?: MessageAgentSessionUpdate[] } | { error: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Whether the user's sign-in is fresh: this request's session, else their newest one. */
async function signInFresh(userId: ObjectId, sessionId: string | undefined): Promise<boolean> {
	if (sessionId && (await collections.sessions.countDocuments({ sessionId }, { limit: 1 }))) {
		return sessionAuthFresh(sessionId);
	}
	const newest = await collections.sessions.find({ userId }).sort({ updatedAt: -1 }).next();
	return authTimeFresh(newest?.authTime);
}

/** The caller's device for an id from the model: not theirs, not paired or not there all read the same. */
async function deviceFor(
	userId: ObjectId,
	deviceId: string,
	modelId?: string
): Promise<{ device: CodeDevice } | { error: string }> {
	const checked = await checkOwnedTarget(userId, { deviceId, modelId });
	if (!checked.ok) {
		return {
			error:
				checked.error === "That computer is not one of yours."
					? "No such machine. Use agent_sessions to see the user's machines."
					: checked.error,
		};
	}
	return { device: checked.device };
}

const offline = (device: CodeDevice) =>
	`${device.name} is offline. Tell the user to bring the machine online; nothing was sent.`;

function opMessage(err: unknown, what: string): string {
	if (err instanceof OpError) {
		return err.code === "unavailable"
			? `The computer went offline while ${what}.`
			: `${what}: ${err.message}`;
	}
	return `${what}: ${err instanceof Error ? err.message : String(err)}`;
}

function card(
	action: "started" | "prompted",
	device: CodeDevice,
	session: Session,
	workspace: string
): MessageAgentSessionUpdate {
	return {
		type: MessageUpdateType.AgentSession,
		action,
		deviceId: device._id.toString(),
		workspaceId: session.workspaceId,
		sessionId: session.id,
		title: session.title,
		labels: { device: device.name, workspace },
	};
}

async function workspaceLabel(link: MachineLink, workspaceId: string): Promise<string> {
	try {
		return (await workspaceNameOn(link, workspaceId)) ?? workspaceId;
	} catch {
		return workspaceId;
	}
}

// -- agent_sessions ----------------------------------------------------------------------------

async function listSessions(
	userId: ObjectId,
	profile: ProjectAgentProfile | null
): Promise<ToolOutcome> {
	const devices = await collections.codeDevices
		.find({ userId, status: "paired" })
		.sort({ name: 1 })
		.limit(MAX_LISTED_MACHINES)
		.toArray();
	const machines = await Promise.all(
		devices.map(async (device) => {
			const id = device._id.toString();
			if (!isMachineOnline(id)) return { id, name: device.name, state: "offline" as const };
			const link = new MachineLink(id);
			try {
				const [{ workspaces }, { sessions }] = await Promise.all([
					link.workspaceList(),
					link.sessionList(),
				]);
				return {
					id,
					name: device.name,
					state: "online" as const,
					workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
					sessions: sessions
						.filter((s) => !s.parentId)
						.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
						.slice(0, MAX_LISTED_SESSIONS)
						.map((s) => ({
							id: s.id,
							title: clip(s.title, MAX_TITLE),
							workspaceId: s.workspaceId,
							state: sessionState(s),
							updatedAt: s.updatedAt,
						})),
				};
			} catch (err) {
				return {
					id,
					name: device.name,
					state: "online" as const,
					error: opMessage(err, "listing sessions"),
				};
			}
		})
	);
	return {
		text: JSON.stringify({
			machines,
			projectDefault: profile
				? {
						deviceId: profile.deviceId,
						workspaceId: profile.workspaceId,
						machine: profile.labels.device,
						workspace: profile.labels.workspace,
						permissionMode: profile.permissionMode,
						...(profile.modeId ? { modeId: profile.modeId } : {}),
						...(profile.modelId ? { modelId: profile.modelId } : {}),
					}
				: null,
		}),
	};
}

// -- agent_start -------------------------------------------------------------------------------

async function startSession(
	userId: ObjectId,
	args: Record<string, unknown>,
	ctx: AgentToolContext,
	profile: ProjectAgentProfile | null
): Promise<ToolOutcome> {
	const parsed = startSchema.safeParse(args);
	if (!parsed.success) {
		return {
			error: `agent_start needs a prompt (at most ${MAX_AGENT_PROMPT_LENGTH} characters), and a machine and workspace unless the project names a default.`,
		};
	}
	const input = parsed.data;
	// The project's default fills what the model left out; a workspace is only borrowed with its machine.
	const deviceId = input.deviceId ?? profile?.deviceId;
	const workspaceId =
		input.workspaceId ??
		(deviceId && deviceId === profile?.deviceId ? profile.workspaceId : undefined);
	if (!deviceId || !workspaceId) {
		return {
			error:
				"Say which machine and workspace (ids from agent_sessions): this chat's project has no default for them.",
		};
	}
	// The profile's own target gets the profile's mode, model and word; any other target asks.
	const useProfile =
		profile !== null && deviceId === profile.deviceId && workspaceId === profile.workspaceId;
	const modeId = input.modeId ?? (useProfile ? profile.modeId : undefined);
	const modelId = input.modelId ?? (useProfile ? profile.modelId : undefined);
	const permissionMode: PermissionStep = useProfile ? profile.permissionMode : "ask";

	const found = await deviceFor(userId, deviceId, modelId);
	if ("error" in found) return found;
	const { device } = found;
	if (!isMachineOnline(deviceId)) return { error: offline(device) };
	const link = new MachineLink(deviceId);

	let workspace: string | null;
	try {
		workspace = await workspaceNameOn(link, workspaceId);
	} catch (err) {
		return { error: opMessage(err, "listing the machine's workspaces") };
	}
	if (workspace === null) {
		return { error: "That workspace is not on this computer. Use agent_sessions to see them." };
	}

	const title = input.title ?? clip(input.prompt.split("\n")[0], 80);
	const audit = {
		deviceId,
		workspaceId,
		...(ctx.conversationId ? { conversationId: ctx.conversationId.toString() } : {}),
	};
	let session: Session;
	try {
		session = await startAgentSession(link, {
			workspaceId,
			title,
			modeId,
			modelId,
			permissionMode,
			...(permissionMode === "auto" ? { autoClasses: await autoClassesFor(userId) } : {}),
			prompt: input.prompt,
			// The project's connector default goes with the profile's own target, never another.
			...(useProfile && profile.connectorKeys?.length
				? {
						afterCreate: async (created: Session) => {
							await setSessionConnectorKeys(
								userId,
								deviceId,
								created.id,
								profile.connectorKeys ?? []
							);
						},
					}
				: {}),
		});
	} catch (err) {
		const step = err instanceof AgentStepError ? err.step : "create";
		const what = {
			create: "creating the session",
			permission: "setting the permission mode",
			prompt: "sending the prompt",
		}[step];
		await recordCodeAuditRow(userId, {
			action: "agent.start",
			...audit,
			mode: permissionMode,
			outcome: `failed:${step}`,
		});
		return {
			error: `${opMessage(err instanceof AgentStepError ? err.original : err, what)} Nothing more was done.`,
		};
	}
	await recordCodeAuditRow(userId, {
		action: "agent.start",
		...audit,
		sessionId: session.id,
		mode: permissionMode,
		outcome: "ok",
	});
	const word = { ask: "Ask", auto: "Auto", allow: "Allow", deny: "Deny" }[permissionMode];
	return {
		text: JSON.stringify({
			started: true,
			deviceId,
			workspaceId,
			sessionId: session.id,
			title: session.title,
			machine: device.name,
			workspace,
			permissionMode: word,
			note: "The prompt was sent; the session is working on it. Do not wait: read the result later with agent_read when the user asks.",
		}),
		extraUpdates: [card("started", device, session, workspace)],
	};
}

// -- agent_send --------------------------------------------------------------------------------

async function loadSession(
	link: MachineLink,
	sessionId: string
): Promise<{ session: Session } | { error: string }> {
	try {
		const { session } = await link.sessionGet({ sessionId });
		// A subagent is not a session of the user's to drive from here.
		if (session.parentId) return { error: "No such session on that machine." };
		return { session };
	} catch (err) {
		if (err instanceof OpError && err.code === "not_found") {
			return { error: "No such session on that machine." };
		}
		return { error: opMessage(err, "reading the session") };
	}
}

async function sendToSession(
	userId: ObjectId,
	args: Record<string, unknown>,
	ctx: AgentToolContext
): Promise<ToolOutcome> {
	const parsed = sendSchema.safeParse(args);
	if (!parsed.success) {
		return {
			error: `agent_send needs deviceId, sessionId and a prompt (at most ${MAX_AGENT_PROMPT_LENGTH} characters).`,
		};
	}
	const { deviceId, sessionId, prompt } = parsed.data;
	const found = await deviceFor(userId, deviceId);
	if ("error" in found) return found;
	const { device } = found;
	if (!isMachineOnline(deviceId)) return { error: offline(device) };
	const link = new MachineLink(deviceId);
	const loaded = await loadSession(link, sessionId);
	if ("error" in loaded) return loaded;
	const { session } = loaded;
	const busy = busyReason(session);
	if (busy) {
		return {
			error: `"${clip(session.title, MAX_TITLE)}" ${busy}, so the prompt was not sent. Use agent_read to see where it is, and try again later.`,
		};
	}
	const audit = {
		deviceId,
		workspaceId: session.workspaceId,
		sessionId: session.id,
		...(ctx.conversationId ? { conversationId: ctx.conversationId.toString() } : {}),
		// The session keeps its own word: record what it is, never a change.
		...(session.permissionMode ? { mode: session.permissionMode } : {}),
	};
	try {
		await sendPrompt(link, session.id, prompt);
	} catch (err) {
		await recordCodeAuditRow(userId, { action: "agent.send", ...audit, outcome: "failed:prompt" });
		return { error: `${opMessage(err, "sending the prompt")} Nothing was sent.` };
	}
	await recordCodeAuditRow(userId, { action: "agent.send", ...audit, outcome: "ok" });
	const workspace = await workspaceLabel(link, session.workspaceId);
	return {
		text: JSON.stringify({
			prompted: true,
			deviceId,
			workspaceId: session.workspaceId,
			sessionId: session.id,
			title: session.title,
			note: "The prompt was sent; the session keeps its own permission setting. Do not wait: read the result later with agent_read when the user asks.",
		}),
		extraUpdates: [card("prompted", device, session, workspace)],
	};
}

// -- agent_read --------------------------------------------------------------------------------

function textOf(parts: Part[]): string {
	return parts
		.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
		.map((p) => p.text.trim())
		.filter(Boolean)
		.join("\n");
}

function describeMessage(message: { role: string }, parts: Part[]): string {
	const lines: string[] = [];
	const text = textOf(parts);
	if (text) lines.push(text);
	for (const part of parts) {
		if (part.type === "tool") {
			lines.push(`[tool ${part.tool}${part.title ? `: ${part.title}` : ""} (${part.status})]`);
		}
	}
	return `${message.role}:\n${lines.join("\n")}`;
}

async function readSession(userId: ObjectId, args: Record<string, unknown>): Promise<ToolOutcome> {
	const parsed = readSchema.safeParse(args);
	if (!parsed.success) return { error: "agent_read needs deviceId and sessionId." };
	const { deviceId, sessionId, full } = parsed.data;
	const found = await deviceFor(userId, deviceId);
	if ("error" in found) return found;
	const { device } = found;
	if (!isMachineOnline(deviceId)) {
		return {
			text: JSON.stringify({ state: "offline", machine: device.name, note: offline(device) }),
		};
	}
	const link = new MachineLink(deviceId);
	const loaded = await loadSession(link, sessionId);
	if ("error" in loaded) return loaded;
	const { session } = loaded;

	let snapshot;
	try {
		const synced = await link.sessionSync({ sessionId, limit: full ? TRANSCRIPT_MESSAGES : 8 });
		if (!("snapshot" in synced)) return { error: "The machine did not return the transcript." };
		snapshot = synced.snapshot;
	} catch (err) {
		return { error: opMessage(err, "reading the transcript") };
	}
	const questions = snapshot.questions ?? [];
	const state = sessionState(session, questions.length);

	let lastAnswer = "";
	for (let i = snapshot.messages.length - 1; i >= 0; i--) {
		const { message, parts } = snapshot.messages[i];
		if (message.role !== "assistant") continue;
		const text = textOf(parts);
		if (text) {
			lastAnswer = text;
			break;
		}
	}
	const result: Record<string, unknown> = {
		state,
		title: clip(session.title, MAX_TITLE),
		openApprovals: snapshot.permissions.map((p) => ({ tool: p.tool, title: clip(p.title, 200) })),
		openQuestions: questions.flatMap((q) => q.questions.map((x) => clip(x.question, 400))),
		lastAnswer: clip(lastAnswer, MAX_LAST_ANSWER_CHARS),
	};
	if (state === "working") {
		result.note = "Still working: the last answer may be from an earlier turn.";
	}
	if (full) {
		// Newest first, cut at the size limit.
		const chunks: string[] = [];
		let used = 0;
		let cut = snapshot.hasMore === true;
		for (let i = snapshot.messages.length - 1; i >= 0; i--) {
			const chunk = describeMessage(snapshot.messages[i].message, snapshot.messages[i].parts);
			if (used + chunk.length > MAX_TRANSCRIPT_CHARS) {
				cut = true;
				break;
			}
			chunks.push(chunk);
			used += chunk.length;
		}
		result.transcript = chunks.join("\n\n");
		result.transcriptNote = `Newest message first${cut ? "; older messages were left out (size limit)" : ""}.`;
	}
	return { text: JSON.stringify(result) };
}

// -- entry points ------------------------------------------------------------------------------

/**
 * Run one of the four tools for a caller. The one body behind both the tool's `execute` and the
 * approval click's resume: every refusal (switch, sign-in, ownership, offline) is decided here.
 * `profile` is read from the conversation's project when the caller did not pass it.
 */
export async function runAgentSessionTool(
	name: string,
	args: Record<string, unknown>,
	ctx: AgentToolContext,
	profile?: ProjectAgentProfile | null
): Promise<ToolOutcome> {
	if (!AGENT_SESSION_TOOL_NAMES.has(name)) return { error: `Unknown tool: ${name}` };
	const { userId } = ctx;
	if (!userId) return { error: "Driving coding agents needs a signed-in account." };
	if (!codeAgentsEnabled()) return { error: "Coding agents are switched off here." };
	if (!(await signInFresh(userId, ctx.sessionId))) return { error: SIGN_IN_REFUSAL };

	try {
		switch (name) {
			case AGENT_SESSIONS_TOOL_NAME:
				return await listSessions(userId, profile ?? (await profileFor(userId, ctx)));
			case AGENT_START_TOOL_NAME:
				return await startSession(userId, args, ctx, profile ?? (await profileFor(userId, ctx)));
			case AGENT_SEND_TOOL_NAME:
				return await sendToSession(userId, args, ctx);
			default:
				return await readSession(userId, args);
		}
	} catch (err) {
		return { error: opMessage(err, "reaching the machine") };
	}
}

/** The caller's profile for the conversation's project, as the API shape. */
async function profileFor(
	userId: ObjectId,
	ctx: AgentToolContext
): Promise<ProjectAgentProfile | null> {
	if (!ctx.conversationId) return null;
	const conversation = await collections.conversations.findOne(
		{ _id: ctx.conversationId, userId },
		{ projection: { projectId: 1 } }
	);
	if (!conversation?.projectId) return null;
	const row = await getProjectAgentProfile(conversation.projectId, userId);
	if (!row) return null;
	return profileView(row);
}

/**
 * The tool's `BuiltinToolResult` for a run: updates ride in `extraUpdates` so the card is
 * persisted with the message like any other update.
 */
function asBuiltinResult(outcome: ToolOutcome): BuiltinToolResult {
	return "error" in outcome
		? { error: outcome.error }
		: {
				resultText: outcome.text,
				...(outcome.extraUpdates ? { extraUpdates: outcome.extraUpdates } : {}),
			};
}

/**
 * Whether the turn offers the four tools, and the caller's default target for the conversation's
 * project: /code on for the deployment, the caller holds `code_agents` and has a paired machine.
 * `undefined` withholds them.
 */
export async function agentSessionsFor(
	locals: App.Locals | undefined,
	projectId: ObjectId | undefined
): Promise<{ profile: ProjectAgentProfile | null } | undefined> {
	const user = locals?.user;
	if (!locals || !user || !codeAgentsEnabled()) return undefined;
	try {
		if (!(await codeAgentsAllowedFor(locals))) return undefined;
		const paired = await collections.codeDevices.countDocuments(
			{ userId: user._id, status: "paired" },
			{ limit: 1 }
		);
		if (paired === 0) return undefined;
		// A profile is read only while the person can still see the project.
		const project = await projectForMember(projectId, locals);
		const row = project ? await getProjectAgentProfile(project._id, user._id) : null;
		return { profile: row ? profileView(row) : null };
	} catch {
		return undefined;
	}
}

const noArgs = { type: "object", properties: {}, required: [] as string[] };

/** The four builtins. `profile` is the caller's own default target for this chat's project, if any. */
export function createAgentSessionBuiltins(options: {
	profile?: ProjectAgentProfile | null;
}): BuiltinTool[] {
	const profile = options.profile ?? null;
	const defaultLine = profile
		? ` This project's default target: workspace "${profile.labels.workspace}" on "${profile.labels.device}" (deviceId ${profile.deviceId}, workspaceId ${profile.workspaceId}), permission ${profile.permissionMode}; omit deviceId and workspaceId to use it.`
		: " This chat has no default target: choose a machine and workspace from agent_sessions.";

	const run = (name: AgentSessionToolName): BuiltinTool["execute"] => {
		return async (args, ctx) =>
			asBuiltinResult(
				await runAgentSessionTool(
					name,
					args,
					{ userId: ctx.userId, conversationId: ctx.conversationId, sessionId: ctx.sessionId },
					profile
				)
			);
	};

	return [
		{
			name: AGENT_SESSIONS_TOOL_NAME,
			exemptFromToolRestraint: true,
			definition: {
				type: "function",
				function: {
					name: AGENT_SESSIONS_TOOL_NAME,
					description:
						"List the user's paired coding machines with their workspaces and recent sessions (state: idle, working, needs-you, error, offline) and the project's default target if any. Call it before agent_start or agent_send to get ids.",
					parameters: noArgs,
				},
			},
			execute: run(AGENT_SESSIONS_TOOL_NAME),
		},
		{
			name: AGENT_START_TOOL_NAME,
			exemptFromToolRestraint: true,
			preprompt:
				"agent_start and agent_send hand work to a coding agent on the user's own machine and return at once: " +
				"never wait for the result. Tell the user the session was started or prompted, and read it with agent_read " +
				"only later (when they ask, or in a later turn). Write the prompt self-contained: the agent cannot see this chat." +
				defaultLine,
			definition: {
				type: "function",
				function: {
					name: AGENT_START_TOOL_NAME,
					description:
						"Start a new coding-agent session on one of the user's machines and send it a prompt. Returns at once with the session ids; the work runs on the machine and is read later with agent_read. The user approves the call as for other acting tools." +
						defaultLine,
					parameters: {
						type: "object",
						properties: {
							prompt: {
								type: "string",
								description: "What the agent should do, self-contained.",
							},
							deviceId: { type: "string", description: "Machine id from agent_sessions." },
							workspaceId: { type: "string", description: "Workspace id on that machine." },
							title: { type: "string", description: "A short session title." },
							modeId: { type: "string", description: "Agent mode; omit for the default." },
							modelId: { type: "string", description: "Model id; omit for the default." },
						},
						required: ["prompt"],
					},
				},
			},
			execute: run(AGENT_START_TOOL_NAME),
		},
		{
			name: AGENT_SEND_TOOL_NAME,
			exemptFromToolRestraint: true,
			definition: {
				type: "function",
				function: {
					name: AGENT_SEND_TOOL_NAME,
					description:
						"Send a prompt to an existing coding-agent session. Refused while the session is working or waiting for the user: read it with agent_read and try again later. The session keeps its own permission setting. Returns at once.",
					parameters: {
						type: "object",
						properties: {
							deviceId: { type: "string" },
							sessionId: { type: "string" },
							prompt: { type: "string", description: "What to tell the agent, self-contained." },
						},
						required: ["deviceId", "sessionId", "prompt"],
					},
				},
			},
			execute: run(AGENT_SEND_TOOL_NAME),
		},
		{
			name: AGENT_READ_TOOL_NAME,
			exemptFromToolRestraint: true,
			definition: {
				type: "function",
				function: {
					name: AGENT_READ_TOOL_NAME,
					description:
						"Read a coding-agent session: its state, open approvals and questions, and its last answer. `full: true` adds the transcript, newest first and cut at a size limit. Reading never waits for the agent.",
					parameters: {
						type: "object",
						properties: {
							deviceId: { type: "string" },
							sessionId: { type: "string" },
							full: { type: "boolean", description: "Include the (bounded) transcript." },
						},
						required: ["deviceId", "sessionId"],
					},
				},
			},
			execute: run(AGENT_READ_TOOL_NAME),
		},
	];
}
