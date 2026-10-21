/**
 * The triggers: where the app learns that something is worth a push.
 *
 * Four sources, each a few lines that call `notifyUser`:
 *
 * - **A coding machine's events** (`observeMachineEvent`, called from the
 *   machine link for *every* event of *every* session, watched or not: a
 *   person with the tab closed is exactly who needs the push). An ask for
 *   permission or an answer is `permission`; a root session going from busy
 *   to idle after `LONG_TURN_MS` is `agentTurn`; a failed background task is
 *   `backgroundTask`.
 * - **A scheduled run**, which is an agent turn started by the scheduler.
 *   `afterScheduleRun` hears the dispatch's own outcome, and remembers the
 *   session so that the turn's end, heard through the machine events, is the
 *   run's end. It replaces `agentTurn` for that session: one notification
 *   for one thing.
 * - **A chat generation** (`chatTurnFinished`), default off.
 *
 * State here is in memory and bounded; a restart forgets a turn in flight,
 * which loses one notification and never sends a wrong one.
 */

import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { parseBackgroundTaskXml } from "$lib/server/code/machineTimeline";
import type { Envelope } from "$lib/types/machineProtocol";
import type { ScheduleRun } from "$lib/types/Schedule";
import { LONG_TURN_MS, type PushEvent } from "$lib/utils/pushEvents";
import { notifyUser, type PushMessage } from "./notify";

type Notify = (userId: ObjectId, event: PushEvent, message: PushMessage) => unknown;

interface Deps {
	notify: Notify;
	now: () => number;
}

const realDeps: Deps = { notify: (u, e, m) => notifyUser(u, e, m), now: () => Date.now() };

const MAX_TRACKED = 2000;
const STALE_MS = 6 * 3600_000;

interface TurnState {
	busySince: number;
	failed: boolean;
}

const turns = new Map<string, TurnState>();
const scheduledSessions = new Map<
	string,
	{ userId: ObjectId; name: string; scheduleId: string; at: number }
>();
const announced = new Map<string, number>();

const key = (deviceId: string, sessionId: string) => `${deviceId}:${sessionId}`;

function sweep(map: Map<string, { at?: number; busySince?: number }>, now: number) {
	if (map.size < MAX_TRACKED) return;
	for (const [k, v] of map) {
		const at = v.at ?? v.busySince ?? 0;
		if (now - at > STALE_MS) map.delete(k);
	}
	// Still over: drop the oldest insertions (Map iterates in insertion order).
	for (const k of map.keys()) {
		if (map.size < MAX_TRACKED) break;
		map.delete(k);
	}
}

export function agentUrl(deviceId: string, sessionId: string): string {
	return `/code?device=${encodeURIComponent(deviceId)}&agent=${encodeURIComponent(sessionId)}`;
}

/** An ask is announced once however many times the machine repeats it. */
function firstTime(id: string, now: number): boolean {
	if (announced.has(id)) return false;
	announced.set(id, now);
	if (announced.size > MAX_TRACKED) {
		for (const k of announced.keys()) {
			if (announced.size <= MAX_TRACKED / 2) break;
			announced.delete(k);
		}
	}
	return true;
}

/**
 * One envelope from a machine owned by `userId`. Synchronous and cheap on the
 * common path (a token delta returns on its first line): it runs for every
 * event the machine link receives.
 */
export function observeMachineEvent(
	userId: ObjectId,
	deviceId: string,
	envelope: Envelope,
	deps: Deps = realDeps
): void {
	const { event, sessionId } = envelope;
	switch (event.kind) {
		case "permission.asked":
		case "question.asked": {
			const id = event.request.id;
			if (!firstTime(`${deviceId}:${id}`, deps.now())) return;
			deps.notify(userId, "permission", {
				title: "An agent needs you",
				body:
					event.kind === "permission.asked"
						? "A coding agent is waiting for your approval."
						: "A coding agent has a question for you.",
				path: agentUrl(deviceId, envelope.rootSessionId ?? sessionId),
				tag: `ask-${id}`,
			});
			return;
		}
		case "status": {
			const k = key(deviceId, sessionId);
			if (event.status === "busy" || event.status === "retry") {
				if (!turns.has(k)) {
					sweep(turns, deps.now());
					turns.set(k, { busySince: deps.now(), failed: false });
				}
				return;
			}
			if (event.status !== "idle") return;
			const turn = turns.get(k);
			if (!turn) return;
			turns.delete(k);
			turnEnded(userId, deviceId, envelope, turn, deps);
			return;
		}
		case "error": {
			const turn = turns.get(key(deviceId, sessionId));
			if (turn) turn.failed = true;
			return;
		}
		case "part": {
			const part = event.part;
			if (part.type !== "text" || !part.synthetic) return;
			const task = parseBackgroundTaskXml(part.text);
			if (task?.state !== "error") return;
			if (!firstTime(`${deviceId}:task:${task.id}`, deps.now())) return;
			deps.notify(userId, "backgroundTask", {
				title: "A background task failed",
				body: "An agent's background task ended with an error.",
				path: agentUrl(deviceId, envelope.rootSessionId ?? sessionId),
				tag: `task-${task.id}`,
			});
			return;
		}
		default:
			return;
	}
}

function turnEnded(
	userId: ObjectId,
	deviceId: string,
	envelope: Envelope,
	turn: TurnState,
	deps: Deps
): void {
	const { sessionId } = envelope;
	const scheduled = scheduledSessions.get(key(deviceId, sessionId));
	if (scheduled) {
		scheduledSessions.delete(key(deviceId, sessionId));
		deps.notify(scheduled.userId, "scheduleRun", {
			title: turn.failed ? "Scheduled run failed" : "Scheduled run finished",
			body: turn.failed
				? `"${scheduled.name}" stopped with an error.`
				: `"${scheduled.name}" has finished.`,
			path: agentUrl(deviceId, sessionId),
			tag: `schedule-${scheduled.scheduleId}`,
		});
		return;
	}
	// A subagent finishing is part of its parent's turn, not an event.
	if (envelope.rootSessionId && envelope.rootSessionId !== sessionId) return;
	if (deps.now() - turn.busySince < LONG_TURN_MS) return;
	deps.notify(userId, "agentTurn", {
		title: turn.failed ? "An agent stopped with an error" : "An agent finished",
		body: turn.failed
			? "A long coding turn ended with an error."
			: "A long coding turn has finished.",
		path: agentUrl(deviceId, sessionId),
		tag: `turn-${sessionId}`,
	});
}

/**
 * The scheduler's record of one occurrence. A dispatch that failed or found
 * the machine offline is the whole story (nothing will run), so it is told
 * now; one that was sent starts a turn whose end is told later.
 */
export function afterScheduleRun(
	run: Pick<ScheduleRun, "status" | "userId" | "scheduleName" | "scheduleId" | "result" | "detail">,
	deps: Deps = realDeps
): void {
	if (run.status === "failed" || run.status === "missed-offline") {
		deps.notify(run.userId, "scheduleRun", {
			title: run.status === "failed" ? "Scheduled run failed" : "Scheduled run missed",
			body:
				run.status === "failed"
					? `"${run.scheduleName}" could not run.`
					: `"${run.scheduleName}" did not run: the machine was offline.`,
			path: "/code?view=schedules",
			tag: `schedule-${run.scheduleId.toString()}`,
		});
		return;
	}
	if (run.status !== "sent") return;
	const deviceId = run.result?.ids["deviceId"];
	const sessionId = run.result?.ids["sessionId"];
	if (!deviceId || !sessionId) return;
	sweep(scheduledSessions, deps.now());
	scheduledSessions.set(key(deviceId, sessionId), {
		userId: run.userId,
		name: run.scheduleName,
		scheduleId: run.scheduleId.toString(),
		at: deps.now(),
	});
}

/** A chat generation ended. Only a long one that completed is news. */
export function chatTurnFinished(
	params: {
		userId: ObjectId | undefined;
		conversationId: ObjectId;
		startedAt: number;
		status: string;
	},
	deps: Deps = realDeps
): void {
	if (!params.userId || params.status !== "completed") return;
	if (deps.now() - params.startedAt < LONG_TURN_MS) return;
	deps.notify(params.userId, "chatTurn", {
		title: "Your answer is ready",
		body: "A long chat reply has finished.",
		path: `/conversation/${params.conversationId.toString()}`,
		tag: `chat-${params.conversationId.toString()}`,
	});
}

export function _resetWatchState(): void {
	turns.clear();
	scheduledSessions.clear();
	announced.clear();
}

/** Log-and-continue wrapper for the call sites: a push must never break what it reports. */
export function safely(fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.warn({ err: String(err) }, "push: trigger failed");
	}
}
