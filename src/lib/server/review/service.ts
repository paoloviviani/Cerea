/**
 * The review service (ADR 0107 sections 2 and 3, ADR 0105 section 2): a machine's permission ask on
 * a session whose word is Allow (the composer's Auto) is judged by a decision model instead of
 * waking the user, when the deployment's rows, the machine's owner and the reviewer's availability
 * all say so. The reviewer only ever allows once or escalates; every other outcome is "comes to
 * you", with the reason on the push, the card and the log.
 *
 * The "needs you" push is interposed: it is held until the decision lands, and a watchdog pushes
 * anyway when nothing lands in time (a held push plus a crashed service would be a silent ask).
 *
 * The credential is the machine owner's own background grant, the one scheduled chat runs use
 * (`schedules/grants.ts`): asks arrive on the machine link with no browser token, and a deployment
 * key would make every user's reviews one account. No grant, or a refresh that fails, escalates.
 */
import { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { collections } from "$lib/server/database";
import {
	answererFor,
	appendReviewLog,
	autoPermissionsEnabled,
	deviceOptedOut,
	getAgentReviewSettings,
} from "$lib/server/agentReview";
import { MachineLink } from "$lib/server/code/machines";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";
import { accessTokenFor } from "$lib/server/schedules/grants";
import type { AgentReviewSettings, ReviewOutcome } from "$lib/types/AgentReview";
import type { Envelope, PermissionClass, PermissionRequest } from "$lib/types/machineProtocol";
import { _resetHealth, mayCall, noteCallFailed, noteCallOk } from "./health";
import { askDecisionModel, type DecisionResult } from "./call";
import { tooLong, type AskFields } from "./frame";
import { staticEscalateReason } from "./static";
import {
	allowedNote,
	belowNote,
	cappedNote,
	clearReviewNote,
	noAccessNote,
	refusedNote,
	ruleNote,
	setReviewNote,
	unavailableNote,
} from "./wording";

/** What the service needs from the outside; the defaults are the real ones, specs pass fakes. */
export interface ReviewDeps {
	settings: () => Promise<AgentReviewSettings>;
	killSwitchOn: () => boolean;
	optedOut: (userId: ObjectId, deviceId: string) => Promise<boolean>;
	/** The owner's own access token from their background grant; throws when there is none. */
	token: (userId: ObjectId) => Promise<string>;
	link: (deviceId: string) => {
		sessionGet(a: {
			sessionId: string;
		}): Promise<{ session: { permissionMode?: string; title: string; workspaceId: string } }>;
		workspaceList(): Promise<{ workspaces: Array<{ id: string; path: string }> }>;
		permissionReply(a: {
			sessionId: string;
			requestId: string;
			decision: "once";
			actor: { kind: "review-model"; modelId: string; reason: string };
		}): Promise<{ alreadyResolved?: boolean }>;
	};
	deviceName: (userId: ObjectId, deviceId: string) => Promise<string>;
	call: typeof askDecisionModel;
	log: typeof appendReviewLog;
	now: () => number;
	watchdogMs: () => number;
}

function envNumber(v: unknown, fallback: number, min: number): number {
	const n = Number(v);
	return Number.isFinite(n) && n >= min ? n : fallback;
}

export const realDeps: ReviewDeps = {
	settings: getAgentReviewSettings,
	killSwitchOn: autoPermissionsEnabled,
	optedOut: deviceOptedOut,
	token: async (userId) => {
		if (!isGatewayPreset()) throw new NoAccess("this deployment has no gateway sign-in");
		// `forSchedule`: the person's switch that stops background use of their access also stops this.
		return (await accessTokenFor(userId, { forSchedule: true })).value;
	},
	link: (deviceId) => new MachineLink(deviceId),
	deviceName: async (userId, deviceId) => {
		if (!ObjectId.isValid(deviceId)) return deviceId;
		const d = await collections.codeDevices.findOne(
			{ _id: new ObjectId(deviceId), userId },
			{ projection: { name: 1 } }
		);
		return d?.name ?? deviceId;
	},
	call: askDecisionModel,
	log: appendReviewLog,
	now: () => Date.now(),
	watchdogMs: () => envNumber(config.AUTO_REVIEW_WATCHDOG_SECONDS, 60, 1) * 1000,
};

export class NoAccess extends Error {}

// -- in-process state: lost on restart, which is acceptable and said --------------------------

const HOUR = 3_600_000;
const perMachine = new Map<string, number[]>();
const inflight = new Set<string>();
const MAX_PARALLEL = 8;
let activeCalls = 0;
const lastCapPush = new Map<string, number>();
const CAP_PUSH_EVERY_MS = 60_000;

export function _resetReviewState(): void {
	perMachine.clear();
	inflight.clear();
	lastCapPush.clear();
	activeCalls = 0;
	_resetHealth();
}

function underCap(deviceId: string, cap: number, now: number): boolean {
	const stamps = (perMachine.get(deviceId) ?? []).filter((t) => now - t < HOUR);
	perMachine.set(deviceId, stamps);
	return stamps.length < cap;
}
function countReview(deviceId: string, now: number): void {
	const stamps = perMachine.get(deviceId) ?? [];
	stamps.push(now);
	perMachine.set(deviceId, stamps);
}

// -- the ask's own fields ---------------------------------------------------------------------

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

/** The command or path of one ask, from its patterns and metadata. */
export function targetsOf(request: PermissionRequest): {
	command?: string;
	path?: string;
	all: string[];
} {
	const md = request.metadata ?? {};
	const mdCommand = str(md["command"]);
	const mdPath = str(md["filepath"]) ?? str(md["filePath"]) ?? str(md["path"]) ?? str(md["file"]);
	const patterns = (request.patterns ?? []).filter((p) => typeof p === "string");
	const all = [...patterns, ...(mdCommand ? [mdCommand] : []), ...(mdPath ? [mdPath] : [])];
	if (request.tool === "bash") return { command: mdCommand ?? patterns.join("\n"), all };
	return { path: mdPath ?? patterns.join(", "), all, ...(mdCommand ? { command: mdCommand } : {}) };
}

// -- the decision -----------------------------------------------------------------------------

type Verdict =
	| { kind: "pass" }
	| { kind: "allowed"; probability: number }
	| {
			kind: "escalate";
			note: string;
			outcome: ReviewOutcome;
			probability: number | null;
			reason: string;
	  };

function esc(
	note: string,
	outcome: ReviewOutcome = "escalated",
	probability: number | null = null
): Verdict {
	return { kind: "escalate", note, outcome, probability, reason: note };
}

/**
 * One ask. `push(note?)` sends the held "needs you" notification, at most once however the paths
 * race (the verdict, the watchdog, a failure); it is never called when the reviewer allowed.
 */
export async function reviewPermissionAsk(
	userId: ObjectId,
	deviceId: string,
	envelope: Envelope,
	push: (note?: string) => void,
	deps: ReviewDeps = realDeps
): Promise<void> {
	const event = envelope.event;
	if (event.kind !== "permission.asked") return push();
	const request = event.request;
	const key = `${deviceId}:${request.id}`;
	if (inflight.has(key)) return;
	inflight.add(key);

	let pushed = false;
	const send = (note?: string) => {
		if (pushed) return;
		pushed = true;
		push(note);
	};
	const watchdog = setTimeout(() => {
		logger.warn({ requestId: request.id }, "review: no decision in time, pushing anyway");
		send();
	}, deps.watchdogMs());
	// A watchdog must never hold the process open.
	(watchdog as { unref?: () => void }).unref?.();

	try {
		const settings = await deps.settings();
		const cls = request.class;
		// Not ours to judge: today's behaviour, the push goes out now.
		if (
			!deps.killSwitchOn() ||
			!settings.enabled ||
			!settings.decisionModelId ||
			!cls ||
			answererFor(settings, cls) !== "reviewer" ||
			(await deps.optedOut(userId, deviceId))
		) {
			return send();
		}
		const link = deps.link(deviceId);
		let session: { permissionMode?: string; title: string; workspaceId: string };
		try {
			session = (await link.sessionGet({ sessionId: request.sessionId || envelope.sessionId }))
				.session;
		} catch {
			return send();
		}
		// Plan and Ask sessions are the user's own: only Auto (the machine's `allow`) is routed.
		if (session.permissionMode !== "allow") return send();

		const ctx: Ctx = { userId, deviceId, envelope, request, cls, settings, session, link, deps };
		const verdict = await judge(ctx);
		if (verdict.kind === "pass") return send();
		if (verdict.kind === "escalate") {
			setReviewNote(request.id, { text: verdict.note, allowed: false });
			await record(ctx, {
				outcome: verdict.outcome,
				probability: verdict.probability,
				reason: verdict.reason,
				applied: false,
			});
			// Past the hourly cap pushes are paced: the cards stay in the inbox.
			if (verdict.note === cappedNote() && !capPushDue(deviceId, deps.now())) {
				pushed = true;
				return;
			}
			return send(verdict.note);
		}
		await allow(ctx, verdict.probability, send);
	} catch (err) {
		logger.warn({ err: String(err), requestId: request.id }, "review: failed, escalating");
		send(unavailableNote());
	} finally {
		clearTimeout(watchdog);
		inflight.delete(key);
	}
}

interface Ctx {
	userId: ObjectId;
	deviceId: string;
	envelope: Envelope;
	request: PermissionRequest;
	cls: PermissionClass;
	settings: AgentReviewSettings;
	session: { permissionMode?: string; title: string; workspaceId: string };
	link: ReturnType<ReviewDeps["link"]>;
	deps: ReviewDeps;
}

function capPushDue(deviceId: string, now: number): boolean {
	const last = lastCapPush.get(deviceId) ?? 0;
	if (now - last < CAP_PUSH_EVERY_MS) return false;
	lastCapPush.set(deviceId, now);
	return true;
}

async function judge(ctx: Ctx): Promise<Verdict> {
	const { request, settings, deps, deviceId } = ctx;
	const t = targetsOf(request);

	const rule = staticEscalateReason({ tool: request.tool, targets: t.all });
	if (rule) return esc(ruleNote(rule));

	let workspace = "";
	try {
		const list = await ctx.link.workspaceList();
		workspace = list.workspaces.find((w) => w.id === ctx.session.workspaceId)?.path ?? "";
	} catch {
		/* the model decides on the ask alone; the workspace is context, not a requirement */
	}
	const scope = str(request.metadata?.["scope"]);
	const fields: AskFields = {
		class: ctx.cls,
		...(scope ? { scope } : {}),
		tool: request.tool,
		title: request.title ?? "",
		...(t.command ? { command: t.command } : {}),
		...(t.path ? { path: t.path } : {}),
		sessionTitle: ctx.session.title ?? "",
		workspace,
	};
	// Cut off, a long command could hide what matters in the part the model never saw.
	if (tooLong(fields)) return esc(ruleNote("it is too long to review"));

	const now = deps.now();
	if (!underCap(deviceId, settings.maxPerHourPerMachine, now)) return esc(cappedNote());
	if (!mayCall(now)) return esc(unavailableNote(), "error");
	if (activeCalls >= MAX_PARALLEL) return esc(unavailableNote(), "error");

	let token: string;
	try {
		token = await deps.token(ctx.userId);
	} catch (err) {
		const why = err instanceof Error ? err.message : "no access";
		return {
			kind: "escalate",
			note: noAccessNote(),
			outcome: "error",
			probability: null,
			reason: `${noAccessNote()} (${why})`.slice(0, 500),
		};
	}

	countReview(deviceId, now);
	activeCalls += 1;
	let result: DecisionResult;
	try {
		result = await deps.call({
			token,
			modelId: settings.decisionModelId ?? "",
			instructions: settings.instructions,
			fields,
		});
	} finally {
		activeCalls -= 1;
	}
	if (!result.ok) {
		if (result.kind === "refusal") {
			noteCallOk();
			return esc(refusedNote(), "escalated");
		}
		noteCallFailed();
		return {
			kind: "escalate",
			note: unavailableNote(),
			outcome: "error",
			probability: null,
			reason: `${unavailableNote()} (${result.kind}: ${result.detail})`,
		};
	}
	noteCallOk();
	if (result.probability >= settings.threshold)
		return { kind: "allowed", probability: result.probability };
	return esc(belowNote(result.probability, settings.threshold), "escalated", result.probability);
}

async function allow(ctx: Ctx, p: number, send: (note?: string) => void): Promise<void> {
	const { request, settings } = ctx;
	const model = settings.decisionModelId ?? "";
	// The note is in place before the machine's `permission.replied` reaches the card.
	setReviewNote(request.id, { text: allowedNote(model, p), allowed: true });
	let applied = false;
	let reason = `p=${p.toFixed(2)}`;
	try {
		const res = await ctx.link.permissionReply({
			sessionId: request.sessionId || ctx.envelope.sessionId,
			requestId: request.id,
			decision: "once",
			actor: { kind: "review-model", modelId: model, reason: `p=${p.toFixed(2)}` },
		});
		applied = res.alreadyResolved !== true;
		if (!applied) {
			reason += " (the ask was already answered: not applied)";
			clearReviewNote(request.id);
		}
	} catch (err) {
		clearReviewNote(request.id);
		reason += ` (could not be delivered: ${err instanceof Error ? err.message : "error"})`;
		await record(ctx, { outcome: "error", probability: p, reason, applied: false });
		// The allow never reached the machine: the user has to know.
		setReviewNote(request.id, { text: unavailableNote(), allowed: false });
		return send(unavailableNote());
	}
	await record(ctx, { outcome: "allowed", probability: p, reason, applied });
}

async function record(
	ctx: Ctx,
	row: { outcome: ReviewOutcome; probability: number | null; reason: string; applied: boolean }
): Promise<void> {
	const { request, deps } = ctx;
	const t = targetsOf(request);
	try {
		await deps.log({
			userId: ctx.userId,
			deviceId: ctx.deviceId,
			machine: await deps.deviceName(ctx.userId, ctx.deviceId),
			sessionId: request.sessionId || ctx.envelope.sessionId,
			class: ctx.cls,
			summary: t.command ?? t.path ?? request.title ?? request.tool,
			probability: row.probability,
			outcome: row.outcome,
			reason: row.reason,
			applied: row.applied,
			modelId: ctx.settings.decisionModelId ?? "",
		});
	} catch (err) {
		// The audit is best-effort, like the rest of the store: never let it change the decision.
		logger.warn({ err: String(err) }, "review: could not write the log");
	}
}
