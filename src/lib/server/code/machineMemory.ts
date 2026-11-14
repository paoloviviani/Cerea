/**
 * Agent notes, Cerea's half (PROTOCOL.md §5 "Machine calls", family `memory`): a coding agent
 * keeps short notes for one **session** or one **workspace** through galopin's `memory_*` tools.
 *
 * ## What an agent can and cannot reach
 *
 * Two scopes, and only these:
 *  - `session`: keyed by the calling session's ROOT session id (as the connector family keys its
 *    opt-in), on this computer. A task subagent or delegate child works for the session that
 *    started it and shares its notes; they survive opencode's compaction and restarts;
 *  - `workspace`: keyed by the calling session's workspace id, on this computer; shared by every
 *    session in that workspace.
 *
 * An agent has **no** personal (global), project or chat memory, to read or to write. That is
 * enforced here by the caller's kind, not by the shape of a parameter: this handler is reachable
 * only by a machine call, it resolves the device to its owner itself, and it accepts exactly the
 * two scopes. A request that names a chat scope (`global`, `project`, `conversation`) is refused
 * `forbidden` with a sentence that says so, and anything else is `invalid`. The rows live in
 * their own collection (`agentMemories`), keyed by owner + computer + scope + key, which the
 * chat's memory code never reads, so a session id that exists on another computer or under
 * another user is simply not in the list.
 *
 * ## Untrusted input
 *
 * An agent that has read hostile code may write anything into a note. The notes are shown to the
 * owner in the code panel as notes, the chat never reads them, and what `memory.list` returns to
 * an agent is its own earlier writing and what its owner typed: still data, labelled as such by
 * galopin's tool description.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { CallError } from "$lib/server/code/machineCallError";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	agentNoteViews,
	forgetAgentNote,
	MemoryValidationError,
	rememberAgentNote,
	type AgentNoteKey,
} from "$lib/server/memory/service";
import type { AgentMemoryScope } from "$lib/types/ScopedMemory";
import type { CallErrorCode, CallFrame, CallResFrame } from "$lib/types/machineProtocol";

export const MEMORY_CALL_OPS: string[] = ["memory.list", "memory.save", "memory.forget"];

/** The scopes an agent may name. Everything else is refused by `refuseOtherScopes`. */
export const AGENT_SCOPES = ["session", "workspace"] as const;
/** The chat's own scopes: named here only to refuse them in words an agent understands. */
const CHAT_SCOPES = ["global", "project", "conversation", "personal", "chat", "user"];

/** Writes per computer per minute: a loop in an agent must not fill a person's list. */
export const MAX_WRITES_PER_MINUTE = 30;
/** Notes per computer, over every session and workspace on it: the per-list cap alone would let many sessions add up. */
export const MAX_NOTES_PER_DEVICE = 2000;
const MINUTE_MS = 60_000;
const recent = new Map<string, number[]>();

function underRate(deviceId: string, now = Date.now()): boolean {
	const times = (recent.get(deviceId) ?? []).filter((t) => now - t < MINUTE_MS);
	if (times.length >= MAX_WRITES_PER_MINUTE) {
		recent.set(deviceId, times);
		return false;
	}
	times.push(now);
	recent.set(deviceId, times);
	return true;
}

/** Test hook: forget the rate window. */
export function resetMemoryRate(): void {
	recent.clear();
}

/** An attempt to reach a chat scope: a refusal that is also written to the audit trail (scope word only, no text). */
class ChatScopeRefusal extends CallError {
	constructor(
		readonly attempted: string,
		message: string
	) {
		super("forbidden", message);
	}
}

const scopeArg = z.string().min(1).max(40);
const saveArgs = z.object({ scope: scopeArg, text: z.string().min(1).max(20_000) });
const forgetArgs = z.object({ scope: scopeArg, text: z.string().min(1).max(20_000) });
const listArgs = z.object({ scope: scopeArg.optional() });

interface Ctx {
	frame: CallFrame;
	deviceId: string;
	userId: ObjectId;
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
	const parsed = schema.safeParse(args ?? {});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
		throw new CallError("invalid", `The arguments are not valid${where}: ${issue?.message}.`);
	}
	return parsed.data;
}

/** The only gate between an agent and the chat scopes: a name outside the two is refused. */
function agentScope(raw: string): AgentMemoryScope {
	if ((AGENT_SCOPES as readonly string[]).includes(raw)) return raw as AgentMemoryScope;
	if (CHAT_SCOPES.includes(raw.toLowerCase())) {
		throw new ChatScopeRefusal(
			raw.toLowerCase(),
			`Agents have no ${raw} memory: that belongs to the user's chats. Use scope "session" ` +
				'(this session only) or "workspace" (every session in this workspace).'
		);
	}
	throw new CallError("invalid", 'scope must be "session" or "workspace".');
}

/** The session whose notes these are: the root of the calling session's tree, else the session itself. */
function sessionKey(frame: CallFrame): string {
	return frame.rootSessionId || frame.sessionId;
}

function keyFor(ctx: Ctx, scope: AgentMemoryScope): AgentNoteKey {
	const key = scope === "session" ? sessionKey(ctx.frame) : ctx.frame.caller.workspaceId;
	if (!key) {
		throw new CallError(
			"invalid",
			scope === "session"
				? "This call carries no session."
				: "This session is not in a workspace galopin can name, so it has no workspace notes."
		);
	}
	return { userId: ctx.userId, deviceId: ctx.deviceId, scope, key };
}

const noteOf = (row: { id: string; text: string; source: string }) => ({
	id: row.id,
	text: row.text,
	source: row.source === "user" ? "user" : "agent",
});

async function opList(ctx: Ctx) {
	const args = parseArgs(listArgs, ctx.frame.args);
	const scopes: AgentMemoryScope[] = args.scope
		? [agentScope(args.scope)]
		: ["session", "workspace"];
	const out: Record<string, unknown> = {};
	for (const scope of scopes) {
		// A workspace-less session simply has an empty workspace list.
		const hasKey = scope === "session" ? sessionKey(ctx.frame) : ctx.frame.caller.workspaceId;
		out[scope] = hasKey ? (await agentNoteViews(keyFor(ctx, scope))).map(noteOf) : [];
	}
	return out;
}

async function opSave(ctx: Ctx) {
	const args = parseArgs(saveArgs, ctx.frame.args);
	const scope = agentScope(args.scope);
	const key = keyFor(ctx, scope);
	if (!underRate(ctx.deviceId)) {
		throw new CallError(
			"limit",
			`Agents on this machine have written ${MAX_WRITES_PER_MINUTE} notes in the last minute. Try again later.`
		);
	}
	if (
		(await collections.agentMemories.countDocuments({
			userId: ctx.userId,
			deviceId: ctx.deviceId,
		})) >= MAX_NOTES_PER_DEVICE
	) {
		// At the cap only a repeat of a note already in this list is let through (it adds nothing).
		const wanted = args.text.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
		const repeat = (await agentNoteViews(key)).some(
			(note) => note.text.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "") === wanted
		);
		if (!repeat) {
			throw new CallError(
				"limit",
				`This computer already holds ${MAX_NOTES_PER_DEVICE} agent notes. Ask the user to delete some in the code panel.`
			);
		}
	}
	const { memory, created } = await rememberAgentNote(key, { text: args.text, source: "model" });
	await audit(ctx, "memory.save", created ? "ok" : "unchanged", scope);
	return {
		scope,
		created,
		note: noteOf({ id: memory._id.toString(), text: memory.text, source: "model" }),
	};
}

async function opForget(ctx: Ctx) {
	const args = parseArgs(forgetArgs, ctx.frame.args);
	const scope = agentScope(args.scope);
	const removed = await forgetAgentNote(keyFor(ctx, scope), args.text);
	await audit(ctx, "memory.forget", "ok", scope);
	return { scope, removed: removed.text };
}

/** One row per write: which scope and the outcome. Never the text. */
async function audit(ctx: Ctx, action: string, outcome: string, scope: string): Promise<void> {
	await recordCodeAuditRow(ctx.userId, {
		action,
		deviceId: ctx.deviceId,
		sessionId: ctx.frame.sessionId,
		origin: "agent",
		outcome,
		name: scope,
	});
}

/** Answer one `memory.*` call from the device `deviceId`. Never throws. */
export async function handleMemoryCall(deviceId: string, frame: CallFrame): Promise<CallResFrame> {
	const fail = (code: CallErrorCode, message: string): CallResFrame => ({
		type: "callres",
		id: frame.id,
		ok: false,
		error: { code, message },
	});
	let ctx: Ctx;
	try {
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		if (!device) return fail("forbidden", "This machine is not known to Cerea.");
		if (device.status !== "paired") {
			return fail("forbidden", "This machine is not paired yet; its owner must confirm it.");
		}
		ctx = { frame, deviceId, userId: device.userId };
	} catch (err) {
		logger.warn({ err: String(err), deviceId }, "memory call: device lookup failed");
		return fail("unavailable", "Cerea could not look this machine up; try again.");
	}
	if (!memoryEnabled()) return fail("unavailable", "Notes are switched off on this Cerea.");
	try {
		const result =
			frame.op === "memory.list"
				? await opList(ctx)
				: frame.op === "memory.save"
					? await opSave(ctx)
					: await opForget(ctx);
		return { type: "callres", id: frame.id, ok: true, result };
	} catch (err) {
		if (err instanceof ChatScopeRefusal) {
			await audit(ctx, `${frame.op}.refused`, "forbidden", err.attempted).catch(() => undefined);
		}
		if (err instanceof CallError) return fail(err.code, err.message);
		// A validation refusal is a sentence the agent can act on (empty, too long, full, no match).
		if (err instanceof MemoryValidationError) {
			return fail(err.message.startsWith("No such") ? "not_found" : "invalid", err.message);
		}
		logger.error({ err, deviceId, op: frame.op }, "memory call failed");
		return fail("unavailable", "Cerea could not do that just now; try again.");
	}
}
