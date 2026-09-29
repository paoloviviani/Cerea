/**
 * How the agent transcript names other sessions (PROTOCOL.md §6 "Agent
 * tools"): `session_spawn` and `session_send` are tool calls the model makes
 * between sessions of one machine, and the transcript renders them as what
 * they did — "Spawned ‹title›", "Sent to ‹title›" — each with a link to the
 * other session, rather than as a bare tool card.
 *
 * `AgentView` provides the lookup through context; the tool card and the
 * "From agent" bubble read it. Outside an agent view there is no provider, and
 * both render exactly as before.
 */
import { getContext } from "svelte";
import type { Message } from "$lib/types/Message";
import { ToolResultStatus } from "$lib/types/Tool";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

export const CODE_SESSION_LINKS = Symbol.for("cerea.codeSessionLinks");

export interface CodeSessionLinks {
	/** The panel address of a session on this machine. */
	href(sessionId: string): string;
	/** A session's title as this machine lists it now, when it does. */
	title(sessionId: string): string | undefined;
}

export function getCodeSessionLinks(): CodeSessionLinks | undefined {
	return getContext<CodeSessionLinks | undefined>(CODE_SESSION_LINKS);
}

export type CoordinationCall = {
	kind: "spawn" | "send";
	/** `pending` until the call closes; `done` only on a result that says the
	 * action happened; `refused` for anything else (a decline, a gate). */
	state: "pending" | "done" | "refused";
	/** The other session, when known. */
	sessionId?: string;
	/** Its title as the call names it: a spawn's own, a send's from the lookup. */
	title?: string;
};

/**
 * Read a `session_spawn` / `session_send` tool call. A refusal reaches the
 * model as text (a declined approval, a gate), not as an error, so "done"
 * is claimed only when the result carries what success returns: a spawn's
 * `{sessionId}`, a send's `{}`. Anything else is shown as the plain tool card,
 * where the refusal text is one tap away, rather than labelled as an action
 * that did not happen.
 */
export function coordinationCall(
	name: string | undefined,
	parameters: Record<string, unknown> | undefined,
	result: { text: string | undefined; failed: boolean } | undefined
): CoordinationCall | null {
	if (name !== "session_spawn" && name !== "session_send") return null;
	const kind = name === "session_spawn" ? "spawn" : "send";
	const asText = (value: unknown) => (typeof value === "string" ? value : undefined);
	const target = kind === "send" ? asText(parameters?.target) : undefined;
	const title = kind === "spawn" ? asText(parameters?.title) : undefined;
	if (!result) return { kind, state: "pending", sessionId: target, title };
	if (result.failed) return { kind, state: "refused", sessionId: target, title };
	let parsed: unknown;
	try {
		parsed = JSON.parse((result.text ?? "").trim() || "{}");
	} catch {
		return { kind, state: "refused", sessionId: target, title };
	}
	const object =
		typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	if (!object) return { kind, state: "refused", sessionId: target, title };
	if (kind === "spawn") {
		const sessionId = asText(object.sessionId);
		return sessionId
			? { kind, state: "done", sessionId, title }
			: { kind, state: "refused", title };
	}
	return "error" in object || "refused" in object
		? { kind, state: "refused", sessionId: target }
		: { kind, state: "done", sessionId: target };
}

/** The other sessions a transcript names, for one lookup of their rows: the
 * sender of a "From agent" bubble, a `session_send` target, a spawn's child. */
export function referencedSessionIds(messages: Message[]): string[] {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.sentBy) ids.add(message.sentBy.sessionId);
		if (message.from !== "assistant") continue;
		for (const update of message.updates ?? []) {
			if (update.type !== MessageUpdateType.Tool) continue;
			if (update.subtype === MessageToolUpdateType.Call) {
				const read = coordinationCall(update.call.name, update.call.parameters, undefined);
				if (read?.sessionId) ids.add(read.sessionId);
			} else if (update.subtype === MessageToolUpdateType.Result) {
				if (update.result.status !== ToolResultStatus.Success) continue;
				const text = update.result.outputs
					.map((out) => (typeof out.text === "string" ? out.text : ""))
					.join("");
				const read = coordinationCall(update.result.call.name, update.result.call.parameters, {
					text,
					failed: false,
				});
				if (read?.state === "done" && read.sessionId) ids.add(read.sessionId);
			}
		}
	}
	return [...ids];
}
