/**
 * Starting and prompting a coding session from the server, with no browser: the one place the
 * scheduled-action executor (`scheduleAgentExecutor.ts`) and the chat's `agent_*` tools
 * (`textGeneration/builtinTools/agentSessionTools.ts`, ADR 0106) get their session from, so the
 * two cannot drift. Everything goes over the same `MachineLink` ops the /code panel uses:
 * `session.create`, `session.setMode`/`setModel`, `session.setPermissionMode`, `session.prompt`.
 *
 * Also here: resolving a device the caller owns (any other id is refused as if it did not exist)
 * and the session-state words shared by the tools.
 */
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import type { MachineLink } from "$lib/server/code/machines";
import { allowsModel } from "$lib/server/code/modelPolicy";
import { OpError, type PermissionMode, type Session } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";

/** A device of this user's, by its hex id. A malformed id or somebody else's row is `null`. */
export async function ownedDevice(userId: ObjectId, deviceId: string): Promise<CodeDevice | null> {
	let _id: ObjectId;
	try {
		_id = new ObjectId(deviceId);
	} catch {
		return null;
	}
	return collections.codeDevices.findOne({ _id, userId });
}

/**
 * The checks a target machine passes before anything is stored or sent: it is the caller's own,
 * it is paired, and (when a model is named) the machine may drive that model. The refusals are
 * the same words the schedules API has always used.
 */
export async function checkOwnedTarget(
	userId: ObjectId,
	input: { deviceId: string; modelId?: string }
): Promise<{ ok: true; device: CodeDevice } | { ok: false; error: string }> {
	const device = await ownedDevice(userId, input.deviceId);
	if (!device) return { ok: false, error: "That machine is not one of yours." };
	if (device.status !== "paired") return { ok: false, error: "That machine is not paired." };
	if (input.modelId && !allowsModel(device, input.modelId)) {
		return { ok: false, error: "This machine was enrolled without --allow-free-models." };
	}
	return { ok: true, device };
}

/** The name of a workspace on a live machine, or `null` when the machine has no such workspace. */
export async function workspaceNameOn(
	link: MachineLink,
	workspaceId: string
): Promise<string | null> {
	const { workspaces } = await link.workspaceList();
	return workspaces.find((w) => w.id === workspaceId)?.name ?? null;
}

/** Why a session cannot take a prompt right now, or `null` when it can. */
export function busyReason(session: Session): string | null {
	if (session.pendingPermissions > 0) return "is waiting for an approval";
	if (session.status === "busy" || session.status === "retry") return "is still working";
	return null;
}

/** The state words the chat tools and the session card speak. */
export type AgentSessionState = "idle" | "working" | "needs-you" | "error" | "offline";

export function sessionState(session: Session, openQuestions = 0): AgentSessionState {
	if (session.pendingPermissions > 0 || openQuestions > 0) return "needs-you";
	if (session.status === "busy" || session.status === "retry") return "working";
	if (session.status === "error") return "error";
	return "idle";
}

/** Names the step that failed, so a caller can phrase its own outcome. */
export class AgentStepError extends Error {
	constructor(
		readonly step: "create" | "permission" | "prompt",
		readonly original: unknown
	) {
		super(original instanceof Error ? original.message : String(original));
	}
}

/**
 * A new session on a workspace, or `existing` reused with its mode and model set when they
 * differ. The new session's mode is the panel's own default (`plan`) when none is chosen.
 */
export async function createOrReuseSession(
	link: MachineLink,
	input: {
		workspaceId: string;
		title: string;
		modeId?: string;
		modelId?: string;
		existing?: Session;
	}
): Promise<Session> {
	if (input.existing) {
		let session = input.existing;
		if (input.modeId && session.modeId !== input.modeId) {
			session = (await link.sessionSetMode({ sessionId: session.id, modeId: input.modeId }))
				.session;
		}
		if (input.modelId && session.modelId !== input.modelId) {
			session = (await link.sessionSetModel({ sessionId: session.id, modelId: input.modelId }))
				.session;
		}
		return session;
	}
	return (
		await link.sessionCreate({
			workspaceId: input.workspaceId,
			title: input.title,
			// The panel's own default when none is chosen.
			modeId: input.modeId ?? "plan",
			...(input.modelId ? { modelId: input.modelId } : {}),
		})
	).session;
}

/**
 * Set the session's Deny / Ask / Allow word when it differs. A machine that predates the
 * selector starts every session on Ask: only that word can be left unset. Anything looser must
 * not run, so the error propagates.
 */
export async function applyPermissionWord(
	link: MachineLink,
	session: Session,
	mode: PermissionMode
): Promise<void> {
	if (session.permissionMode === mode) return;
	try {
		await link.sessionSetPermissionMode({ sessionId: session.id, mode });
	} catch (err) {
		const unsupported = err instanceof OpError && err.code === "unsupported";
		if (!(unsupported && mode === "ask")) throw err;
	}
}

/** Send the prompt (a fresh client message id each time). */
export async function sendPrompt(link: MachineLink, sessionId: string, text: string) {
	await link.sessionPrompt({ sessionId, text, clientMessageId: randomUUID() });
}

/**
 * The chat's start: create the session, set its word, send the prompt. Each failure is tagged
 * with its step (`AgentStepError`) so the caller can say what could not be done.
 */
export async function startAgentSession(
	link: MachineLink,
	input: {
		workspaceId: string;
		title: string;
		modeId?: string;
		modelId?: string;
		permissionMode: PermissionMode;
		prompt: string;
	}
): Promise<Session> {
	let session: Session;
	try {
		session = await createOrReuseSession(link, input);
	} catch (err) {
		throw new AgentStepError("create", err);
	}
	try {
		await applyPermissionWord(link, session, input.permissionMode);
	} catch (err) {
		throw new AgentStepError("permission", err);
	}
	try {
		await sendPrompt(link, session.id, input.prompt);
	} catch (err) {
		throw new AgentStepError("prompt", err);
	}
	return session;
}
