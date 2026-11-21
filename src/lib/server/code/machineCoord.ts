/**
 * Relayed coordination, Cerea's half (ADR 0121; PROTOCOL.md §5 family `coord`). A coding agent on
 * one of a user's computers lists, reads, messages and starts sessions on another computer of the
 * same user. galopin decides and asks (the card); Cerea enforces and routes; the target's galopin
 * delivers with a template it owns.
 *
 * The order of checks in `handleCoordCall` is the ADR's (section 3), on every call, with no verdict
 * cached:
 *
 *  1. the caller's computer gives the owner (the socket's own pairing; nothing in `args` names one);
 *  2. the deployment's and the user's switches;
 *  3. the target is the SAME owner's paired computer (one refusal for every other case);
 *  4. the target is live, capable and not vetoed;
 *  5. size and shape;
 *  6. the rates;
 *  7. the approval ticket (consumed once, bound to the content by a hash);
 *  8. the target as it is NOW (a session still top-level, its word not looser than the card showed);
 *  9. delivery, audit, answer.
 *
 * Cerea never trusts the caller's computer for a fact about the target or for "an approval
 * happened": it reads names itself and demands the one-shot ticket the owner's answer minted.
 */

import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { codeRelayedCoordinationEnabled } from "$lib/server/codeEnabled";
import { recordCodeAuditRow, type CodeAuditInput } from "$lib/server/code/audit";
import { CallError } from "$lib/server/code/machineCallError";
import { MachineLink, isMachineOnline, type CoordFrom } from "$lib/server/code/machines";
import {
	callerFacts,
	looser,
	ownedDevice,
	relayRefusal,
	targetFacts,
	type CallerFacts,
	type TargetFacts,
	type Word,
} from "$lib/server/code/relay/facts";
import { ticketHash, type RelayCovered } from "$lib/server/code/relay/hash";
import {
	askCapReason,
	checkHopAndDepth,
	enforcedHop,
	LIMITS,
	takeCall,
	takeList,
	writeLedger,
} from "$lib/server/code/relay/limits";
import { consumeTicket } from "$lib/server/code/relay/tickets";
import { relayedCoordinationOn } from "$lib/server/code/relay/switch";
import type { CallErrorCode, CallFrame, CallResFrame } from "$lib/types/machineProtocol";
import type { RelayOp } from "$lib/types/CodeRelay";

export const COORD_CALL_OPS: string[] = [
	"coord.list",
	"coord.resolve",
	"coord.read",
	"coord.send",
	"coord.spawn",
];

const MAX_TEXT_BYTES = 8 << 10;
/** One call's whole bound at Cerea: the target's own is 20 s, this leaves room to answer. */
const DELIVER_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 5_000;

const SWITCH_OFF = "Relayed coordination is switched off in the user's Cerea settings.";
const NO_TICKET = "This needs the user's approval and none was recorded.";

interface Ctx {
	frame: CallFrame;
	deviceId: string;
	userId: ObjectId;
	/** The relay id that joins the caller's, Cerea's and the target's audit lines. */
	relayId: string;
}

const base = z.object({ computerId: z.string() });

const byteLimited = (what: string) =>
	z
		.string()
		.refine((s) => s.trim().length > 0, { message: `${what} is required` })
		.refine((s) => Buffer.byteLength(s, "utf8") <= MAX_TEXT_BYTES, {
			message: `${what} is longer than ${MAX_TEXT_BYTES} bytes`,
		});

const hopSchema = z.number().int().min(1).max(LIMITS.maxHop);
const approvalSchema = z.string().min(1).max(200);

/** Exported for the shared fixtures spec: the call fixtures' args must parse. */
export const COORD_ARG_SCHEMAS = () => ({
	"coord.list": listArgs,
	"coord.resolve": resolveArgs,
	"coord.read": readArgs,
	"coord.send": sendArgs,
	"coord.spawn": spawnArgs,
});

const resolveArgs = z.object({
	op: z.enum(["send", "read", "spawn"]),
	computerId: z.string(),
	sessionId: z.string().min(1).max(256).optional(),
	workspaceId: z.string().min(1).max(256).optional(),
});
const readArgs = z.object({
	computerId: z.string(),
	sessionId: z.string().min(1).max(256),
	last: z.number().int().min(1).max(50),
	hop: hopSchema,
	approvalId: approvalSchema,
});
const sendArgs = z.object({
	computerId: z.string(),
	sessionId: z.string().min(1).max(256),
	text: byteLimited("text"),
	hop: hopSchema,
	approvalId: approvalSchema,
});
const spawnArgs = z.object({
	computerId: z.string(),
	workspaceId: z.string().min(1).max(256),
	prompt: byteLimited("prompt"),
	title: z.string().min(1).max(200),
	mode: z.enum(["plan", "build"]),
	hop: hopSchema,
	approvalId: approvalSchema,
});
const listArgs = z.object({ workspaces: z.boolean().optional() });

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
		throw new CallError("invalid", `The arguments are not valid${where}: ${issue?.message}.`);
	}
	return parsed.data;
}

// -- audit (no content: ids and an outcome) -------------------------------------------------------

type Outcome =
	| "ok"
	| "forbidden"
	| "unavailable"
	| "limit"
	| "invalid"
	| "not_found"
	| "unsupported"
	| "switch_off"
	| "no_ticket"
	| "ticket_mismatch";

interface AuditFacts {
	targetDeviceId?: string;
	targetWorkspaceId?: string;
	targetSessionId?: string;
	hop?: number;
}

async function audit(
	ctx: Ctx,
	op: string,
	outcome: Outcome,
	facts: AuditFacts = {}
): Promise<void> {
	const input: CodeAuditInput = {
		action: outcome === "ok" ? `coord.${op}` : `coord.${op}.refused`,
		deviceId: ctx.deviceId,
		sessionId: ctx.frame.sessionId,
		origin: "agent",
		outcome,
		relayId: ctx.relayId,
		...facts,
	};
	// The caller's workspace is not known without a read; the row names ids Cerea already holds.
	await recordCodeAuditRow(ctx.userId, input);
}

function outcomeOf(err: CallError, mismatch: boolean): Outcome {
	if (mismatch) return "ticket_mismatch";
	return err.code;
}

// -- the call ---------------------------------------------------------------------------------------

function fail(frame: CallFrame, code: CallErrorCode, message: string): CallResFrame {
	return { type: "callres", id: frame.id, ok: false, error: { code, message } };
}

/** Marks a refusal that is the ticket's hash not matching: a security signal of its own. */
class TicketMismatch extends CallError {}
/** Marks a refusal for a missing ticket. */
class NoTicket extends CallError {}
/** Marks a refusal for the switch. */
class SwitchOff extends CallError {}

/** Answer one `coord.*` call from the device `deviceId`. Never throws. */
export async function handleCoordCall(deviceId: string, frame: CallFrame): Promise<CallResFrame> {
	let ctx: Ctx;
	try {
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		if (!device) return fail(frame, "forbidden", "This machine is not known to Cerea.");
		if (device.status !== "paired") {
			return fail(frame, "forbidden", "This machine is not paired yet; its owner must confirm it.");
		}
		// 1. The owner is whoever owns the paired computer this frame arrived from.
		ctx = { frame, deviceId, userId: device.userId, relayId: randomUUID() };
	} catch (err) {
		logger.warn({ err: String(err), deviceId }, "coord call: device lookup failed");
		return fail(frame, "unavailable", "Cerea could not look this machine up; try again.");
	}
	const op = frame.op.slice("coord.".length) as "list" | "resolve" | RelayOp;
	let facts: AuditFacts = {};
	let mismatch = false;
	try {
		// 2. The switches.
		if (!codeRelayedCoordinationEnabled() || !(await relayedCoordinationOn(ctx.userId))) {
			throw new SwitchOff("forbidden", SWITCH_OFF);
		}
		switch (op) {
			case "list":
				return ok(frame, await opList(ctx));
			case "resolve":
				return ok(frame, await opResolve(ctx));
			default: {
				const run = await opRelay(ctx, op, (f) => (facts = { ...facts, ...f }));
				await audit(ctx, op, "ok", facts);
				return ok(frame, run);
			}
		}
	} catch (err) {
		if (err instanceof CallError) {
			mismatch = err instanceof TicketMismatch;
			const outcome: Outcome =
				err instanceof SwitchOff
					? "switch_off"
					: err instanceof NoTicket
						? "no_ticket"
						: outcomeOf(err, mismatch);
			if (op === "list") {
				if (outcome === "limit" || err instanceof SwitchOff) {
					await audit(ctx, "list", outcome);
				}
			} else if (op !== "resolve") {
				await audit(ctx, op, outcome, facts);
			}
			return fail(frame, err.code, err.message);
		}
		logger.error({ err, deviceId, op: frame.op }, "coord call failed");
		if (op !== "list" && op !== "resolve") await audit(ctx, op, "unavailable", facts);
		return fail(frame, "unavailable", "Cerea could not do that just now; try again.");
	}
}

function ok(frame: CallFrame, result: unknown): CallResFrame {
	return { type: "callres", id: frame.id, ok: true, result };
}

// -- coord.list -----------------------------------------------------------------------------------

async function opList(ctx: Ctx) {
	const args = parse(listArgs, ctx.frame.args ?? {});
	await takeList(ctx.userId, ctx.deviceId);
	const devices = await collections.codeDevices
		.find({ userId: ctx.userId, status: "paired", _id: { $ne: new ObjectId(ctx.deviceId) } })
		.sort({ name: 1 })
		.limit(LIMITS.maxListedComputers + 1)
		.toArray();
	const truncated = devices.length > LIMITS.maxListedComputers;
	const listed = devices.slice(0, LIMITS.maxListedComputers);
	const notes: string[] = [];
	if (truncated) notes.push(`Only the first ${LIMITS.maxListedComputers} computers are listed.`);
	const computers: Array<{
		id: string;
		name: string;
		online: boolean;
		relay: boolean;
		self: false;
		workspaces?: Array<{ id: string; name: string }>;
	}> = [];
	const sessions: Array<Record<string, unknown>> = [];
	await Promise.all(
		listed.map(async (device) => {
			const id = device._id.toHexString();
			const online = isMachineOnline(id);
			const refusal = relayRefusal(device);
			const entry: (typeof computers)[number] = {
				id,
				name: device.name,
				online,
				relay: refusal === null,
				self: false,
			};
			computers.push(entry);
			if (refusal) return;
			// The target answers, so its own veto is honoured; one slow computer is left out with a
			// note, never an error.
			try {
				const res = await withTimeout(
					new MachineLink(id).coordList({ ...(args.workspaces ? { workspaces: true } : {}) }),
					LIST_TIMEOUT_MS
				);
				for (const s of res.sessions) {
					sessions.push({
						computerId: id,
						computer: device.name,
						sessionId: s.sessionId,
						title: s.title,
						workspaceId: s.workspaceId,
						workspace: s.workspace,
						mode: s.mode,
						status: s.status,
						...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
						...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
					});
				}
				if (args.workspaces && res.workspaces) entry.workspaces = res.workspaces;
			} catch {
				entry.relay = false;
				notes.push(`${device.name} did not answer in time, so its sessions are not listed.`);
			}
		})
	);
	computers.sort((a, b) => a.name.localeCompare(b.name));
	await audit(ctx, "list", "ok");
	return { computers, sessions, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

// -- coord.resolve --------------------------------------------------------------------------------

async function opResolve(ctx: Ctx) {
	const args = parse(resolveArgs, ctx.frame.args);
	// The owner check first (3), so a foreign id reads like an unknown one, then the cap.
	if (args.computerId === ctx.deviceId) {
		throw new CallError("invalid", "That is this computer: use the local session tools.");
	}
	await ownedDevice(ctx.userId, args.computerId);
	const cap = await askCapReason(ctx.userId, ctx.deviceId);
	if (cap) throw new CallError("limit", cap);
	const caller = await callerFacts(ctx.userId, ctx.deviceId, ctx.frame.sessionId);
	const target = await targetFacts(ctx.userId, args);
	return {
		computer: { id: args.computerId, name: target.computer },
		workspace: { id: target.workspaceId, name: target.workspace },
		...(target.session
			? {
					session: {
						id: target.session.id,
						title: target.session.title,
						mode: target.session.word,
						status: target.session.status,
					},
				}
			: {}),
		caller: {
			computer: caller.computer,
			workspace: caller.workspace,
			session: { id: ctx.frame.sessionId, title: caller.sessionTitle },
		},
	};
}

// -- coord.read | send | spawn ------------------------------------------------------------------

type Parsed =
	| ({ op: "send" } & z.infer<typeof sendArgs>)
	| ({ op: "read" } & z.infer<typeof readArgs>)
	| ({ op: "spawn" } & z.infer<typeof spawnArgs>);

function parseRelay(op: RelayOp, args: unknown): Parsed {
	switch (op) {
		case "send":
			return { op, ...parse(sendArgs, args) };
		case "read":
			return { op, ...parse(readArgs, args) };
		default:
			return { op, ...parse(spawnArgs, args) };
	}
}

/** The session or workspace a call names, for the audit and the live read. */
function targetOf(p: Parsed): { sessionId?: string; workspaceId?: string } {
	return p.op === "spawn" ? { workspaceId: p.workspaceId } : { sessionId: p.sessionId };
}

/** What the ticket's hash covers, from this call's own arguments and nothing else. */
function coveredOf(p: Parsed, callerSessionId: string): RelayCovered {
	return {
		op: p.op,
		computerId: p.computerId,
		...targetOf(p),
		text: p.op === "send" ? p.text : null,
		prompt: p.op === "spawn" ? p.prompt : null,
		last: p.op === "read" ? p.last : null,
		title: p.op === "spawn" ? p.title : null,
		mode: p.op === "spawn" ? p.mode : null,
		hop: p.hop,
		callerSessionId,
	};
}

async function opRelay(ctx: Ctx, op: RelayOp, note: (f: AuditFacts) => void) {
	const computerId = parse(base, { computerId: (ctx.frame.args ?? {}).computerId }).computerId;
	// 3. The target is the same owner's paired computer; any other case is the one refusal.
	note({ targetDeviceId: /^[0-9a-f]{24}$/.test(computerId) ? computerId : undefined });
	if (computerId === ctx.deviceId) {
		throw new CallError("invalid", "That is this computer: use the local session tools.");
	}
	const device = await ownedDevice(ctx.userId, computerId);
	// 4. Live, capable and not vetoed.
	const refusal = relayRefusal(device);
	if (refusal) throw refusal;
	// 5. Size and shape.
	const p = parseRelay(op, ctx.frame.args);
	const named = targetOf(p);
	note({ targetSessionId: named.sessionId, targetWorkspaceId: named.workspaceId, hop: p.hop });
	// 6. The rates.
	await takeCall(ctx.userId, ctx.deviceId, op);
	// The hop and the depth, from Cerea's ledger: a lying hop never lowers either.
	const callerSessionId = ctx.frame.sessionId;
	const { hop, depth } = await enforcedHop(ctx.deviceId, callerSessionId, p.hop);
	checkHopAndDepth(hop, depth, op);
	note({ hop });
	// 7. The approval ticket: consumed once, then compared with this call's own arguments.
	const ticket = await consumeTicket(ctx.deviceId, p.approvalId);
	if (!ticket) {
		const cap = await askCapReason(ctx.userId, ctx.deviceId);
		if (cap) throw new CallError("limit", cap);
		throw new NoTicket(
			"forbidden",
			`${NO_TICKET} Answer the card in Cerea (an answer given on the computer itself does not count), then ask again.`
		);
	}
	const hash = ticketHash(coveredOf(p, callerSessionId));
	if (ticket.userId.toHexString() !== ctx.userId.toHexString() || ticket.hash !== hash) {
		throw new TicketMismatch("forbidden", NO_TICKET + " What was approved is not what was sent.");
	}
	// 8. The target as it is now: top-level, and not looser than the card showed.
	const target = await targetFacts(ctx.userId, { op, computerId, ...named });
	if (target.session) {
		const approved = ticket.facts.target.word as Word | undefined;
		if (approved && looser(target.session.word, approved)) {
			throw new CallError(
				"forbidden",
				`That session's permissions were loosened after the user approved this (it was on ${approved}, it is now on ${target.session.word}). Ask again.`
			);
		}
	}
	const caller = await callerFacts(ctx.userId, ctx.deviceId, callerSessionId);
	const from = fromOf(ctx, caller, callerSessionId);
	// 9. Deliver. A send is never retried: a duplicate delivery is worse than a loss, and the
	// answer for a timeout says it may have arrived.
	const link = new MachineLink(computerId);
	const result = await deliver(ctx, link, p, hop, from, target);
	const delivered = result.sessionId ?? named.sessionId;
	if (delivered) {
		await writeLedger(ctx.userId, computerId, delivered, hop, op === "spawn" ? depth + 1 : 0);
		note({ targetSessionId: delivered });
	}
	return result.body;
}

function fromOf(ctx: Ctx, caller: CallerFacts, sessionId: string): CoordFrom {
	return {
		computerId: ctx.deviceId,
		computer: caller.computer,
		workspaceId: caller.workspaceId,
		workspace: caller.workspace,
		sessionId,
		title: caller.sessionTitle,
	};
}

async function deliver(
	ctx: Ctx,
	link: MachineLink,
	p: Parsed,
	hop: number,
	from: CoordFrom,
	target: TargetFacts
): Promise<{ body: unknown; sessionId?: string }> {
	try {
		switch (p.op) {
			case "send": {
				await withTimeout(
					link.coordSend({ sessionId: p.sessionId, text: p.text, hop, from, relayId: ctx.relayId }),
					DELIVER_TIMEOUT_MS
				);
				return { body: {} };
			}
			case "read": {
				const res = await withTimeout(
					link.coordRead({
						sessionId: p.sessionId,
						last: p.last,
						hop,
						from,
						relayId: ctx.relayId,
						computer: target.computer,
					}),
					DELIVER_TIMEOUT_MS
				);
				return { body: { text: res.text, truncated: res.truncated } };
			}
			default: {
				const res = await withTimeout(
					link.coordSpawn({
						workspaceId: p.workspaceId,
						prompt: p.prompt,
						title: p.title,
						mode: p.mode,
						hop,
						from,
						relayId: ctx.relayId,
					}),
					DELIVER_TIMEOUT_MS
				);
				return {
					body: {
						sessionId: res.sessionId,
						title: res.title,
						workspace: res.workspace || target.workspace,
						computer: target.computer,
					},
					sessionId: res.sessionId,
				};
			}
		}
	} catch (err) {
		throw deliveryError(err, p.op, target.computer);
	}
}

/** The target's refusal or a failure on the way, as a sentence the model can read. */
function deliveryError(err: unknown, op: RelayOp, computer: string): CallError {
	if (err instanceof CallError) return err;
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	if (err instanceof Error && err.message === "timeout") {
		return new CallError(
			"unavailable",
			op === "read"
				? `${computer} did not answer in time.`
				: `${computer} did not answer in time. It may or may not have arrived: read the session before trying again.`
		);
	}
	if (code === "unavailable") {
		return new CallError(
			"unavailable",
			/not connected|closed/i.test(message)
				? `${computer} is offline; nothing was sent.`
				: `${computer} could not be reached right now. ${op === "read" ? "" : "It may or may not have arrived: read the session before trying again."}`.trim()
		);
	}
	if (code === "not_found") return new CallError("not_found", `No such session on ${computer}.`);
	if (code === "forbidden" || code === "unsupported") {
		return new CallError(
			"unsupported",
			`${computer}'s owner turned relayed coordination off on that computer.`
		);
	}
	if (code === "invalid")
		return new CallError("invalid", message || `${computer} refused the request.`);
	logger.warn({ code, message }, "coord: the target refused or failed");
	return new CallError("unavailable", `${computer} could not take that right now.`);
}
