/**
 * The "chat" executor for scheduled actions: a prompt posted into one of the
 * person's conversations (or a new one each time), answered by a normal
 * server-side turn.
 *
 * **Target** (stored, validated by `validateTarget`):
 * `{ mode: "continue" | "new", conversationId?, model?, projectId?, billingGroupId?, labels }`.
 * "continue" posts into `conversationId`, which the person owns. "new" starts a
 * conversation each run with `model` and `projectId` (copied from
 * `conversationId` when none is named, so a conversation can be the template).
 *
 * **A run** is the conversation route's own turn (`routes/conversation/[id]`), driven
 * by a request this file builds: the same pipeline as a chat message, rate limits,
 * persistence, resumable log and all. Only the identity differs: the schedule's
 * own gateway key stands in for the session token, and `locals.scheduledRun` tells
 * the pipeline nobody is watching, so the browser sandbox, questions and the
 * `schedule` tool are withheld and a tool that needs approval is refused (as a
 * sub-agent's is). The user message is the `[Scheduled run …]` header and the prompt.
 *
 * **Statuses.** `skipped-still-running` when a turn of that conversation is still
 * generating (the last run's, for "new"); `failed` on a refusal or an error the turn
 * ended on; otherwise `sent`. A run returns once the turn has ended or `earlyWindowMs`
 * has passed, whichever is first: a long turn is not held against the scheduler's
 * lease, and one that ends in the background is still announced (push, unread mark).
 * A first call refused by the gateway (401/403) is fast, so it lands in the window
 * and disables the schedule.
 *
 * **The key.** Minted with the person's session on create and re-enable
 * (`gatewayKeys.ts`), sealed like connector tokens, revoked on delete. A key the
 * gateway refuses disables the schedule with a reason the person can act on and
 * is forgotten; re-enabling mints a fresh one. Off a gateway preset there is
 * no per-person key: the deployment's own endpoint credential serves the turn.
 */

import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";
import { validateModel, models } from "$lib/server/models";
import { isSelectableModel } from "$lib/server/customModels";
import { open, seal, sealingAvailable } from "$lib/server/mcp/secretBox";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";
import { notifyUser } from "$lib/server/push/notify";
import { turnMaxMinutes } from "$lib/server/generation/turnCap";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { Schedule } from "$lib/types/Schedule";
import type { User } from "$lib/types/User";
import { CredentialError, getExecutor, registerExecutor, type ExecutorOutcome } from "./executors";
import { mintKey } from "./gatewayKeys";
import { retryRevocations, revokeOrQueue, SIGN_IN_AGAIN, sessionTokenFor } from "./credentials";
import { runStamp, scheduledChatHeader } from "./runHeader";

/** How long a run waits for its turn before it reports `sent` and lets the turn carry on. */
export const chatRunConfig = {
	earlyWindowMs: 25_000,
	/** Scheduled turns running in this process at once; a tick cannot start more. */
	maxConcurrent: 4,
};

/** A key lives this long; the scheduler renews it `RENEW_BEFORE_DAYS` before it ends. */
export const KEY_LIFETIME_DAYS = 180;
export const RENEW_BEFORE_DAYS = 14;
const DAY_MS = 24 * 3600_000;

let runningTurns = 0;

export { SIGN_IN_AGAIN };

const label = z.string().trim().max(160);

const targetSchema = z.object({
	mode: z.enum(["continue", "new"]),
	conversationId: z.string().min(1).max(64).nullish(),
	model: z.string().min(1).max(256).nullish(),
	projectId: z.string().min(1).max(64).nullish(),
	billingGroupId: z.string().min(1).max(64).nullish(),
	labels: z.object({ conversation: label.optional(), project: label.optional() }).optional(),
});

export type ChatTarget = {
	mode: "continue" | "new";
	conversationId?: string;
	model?: string;
	projectId?: string;
	billingGroupId?: string;
	labels: { conversation?: string; project?: string };
};

export function parseChatTarget(input: unknown): ChatTarget | null {
	const parsed = targetSchema.safeParse(input);
	if (!parsed.success) return null;
	const t = parsed.data;
	if (t.mode === "continue" && !t.conversationId) return null;
	if (t.mode === "new" && !t.conversationId && !t.model) return null;
	return {
		mode: t.mode,
		...(t.conversationId ? { conversationId: t.conversationId } : {}),
		...(t.model ? { model: t.model } : {}),
		...(t.projectId ? { projectId: t.projectId } : {}),
		...(t.billingGroupId ? { billingGroupId: t.billingGroupId } : {}),
		labels: {
			...(t.labels?.conversation ? { conversation: t.labels.conversation } : {}),
			...(t.labels?.project ? { project: t.labels.project } : {}),
		},
	};
}

function objectId(raw: string | undefined): ObjectId | null {
	if (!raw || !ObjectId.isValid(raw)) return null;
	return new ObjectId(raw);
}

async function ownedConversation(userId: ObjectId, id: string | undefined) {
	const _id = objectId(id);
	if (!_id) return null;
	return collections.conversations.findOne(
		{ _id, userId },
		{ projection: { title: 1, model: 1, projectId: 1, messages: 1 } }
	);
}

/** The project's name if this person may still use it (owned, or shared with them or a group of theirs). */
async function projectLabel(
	userId: ObjectId,
	projectId: string,
	token: string | undefined
): Promise<string | null> {
	const user = await collections.users.findOne({ _id: userId });
	if (!user) return null;
	const access = await projectAccess(projectId, userId, await viewerPrincipals(user, token));
	return access ? access.project.name || "Project" : null;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True while a turn of this conversation is generating or parked on a person. */
export async function conversationBusy(conversationId: ObjectId, now: Date): Promise<boolean> {
	// A record older than the turn cap belongs to a process that died: not busy.
	const cutoff = new Date(now.getTime() - (turnMaxMinutes() + 5) * 60_000);
	const row = await collections.turnStates.findOne({
		conversationId,
		status: { $in: ["running", "waiting", "awaiting_input"] },
		updatedAt: { $gt: cutoff },
	});
	return row !== null;
}

interface TurnReport {
	/** The text of an error the turn ended on. */
	error?: { message: string; statusCode?: number };
	finished: boolean;
}

/** Read a turn's JSON-lines stream to its end. Never throws. */
async function readTurn(response: Response): Promise<TurnReport> {
	const report: TurnReport = { finished: false };
	if (!response.body) return report;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const take = (line: string) => {
		const text = line.trim();
		if (!text) return;
		try {
			const event = JSON.parse(text) as {
				type?: string;
				status?: string;
				message?: string;
				statusCode?: number;
			};
			if (event.type !== MessageUpdateType.Status) return;
			if (event.status === MessageUpdateStatus.Error) {
				report.error = {
					message: event.message ?? "The turn ended on an error.",
					...(typeof event.statusCode === "number" ? { statusCode: event.statusCode } : {}),
				};
			} else if (event.status === MessageUpdateStatus.Finished) {
				report.finished = true;
			}
		} catch {
			// Padding and keep-alives are not events.
		}
	};
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			// The route enqueues strings, not bytes: a body made of either reads the same here.
			buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			lines.forEach(take);
		}
		take(buffer);
	} catch (err) {
		logger.warn({ err }, "scheduled_chat_stream_failed");
		report.error ??= {
			message: `The turn's stream broke off${err instanceof Error ? `: ${err.message}` : "."}`,
		};
	}
	return report;
}

/**
 * Only a 401 says the key is dead (the gateway's `invalid_api_key`). A 403 is a refusal of
 * this request or this account for now (a redaction block, a model access group, a missing
 * capability that a group flag restores), so it is an ordinary failed run with the gateway's words.
 */
const refusedByGateway = (report: TurnReport) =>
	report.error?.statusCode === 401 ||
	(report.error?.statusCode === undefined && /\b401\b/.test(report.error?.message ?? ""));

/** What a turn that outlived the run (or any turn) leaves behind: the unread mark and the push. */
async function announce(
	schedule: Schedule,
	conversationId: ObjectId,
	report: TurnReport,
	options: { push: boolean }
): Promise<void> {
	await collections.conversations
		.updateOne({ _id: conversationId }, { $set: { scheduledUnread: true } })
		.catch((err) => logger.warn({ err }, "scheduled_chat_unread_failed"));
	if (!options.push) return;
	await notifyUser(schedule.userId, "scheduleRun", {
		title: report.error ? "Scheduled chat failed" : "Scheduled chat answered",
		body: report.error
			? `"${schedule.name}" stopped with an error.`
			: `"${schedule.name}" has an answer.`,
		path: `/conversation/${conversationId.toString()}`,
		tag: `schedule-${schedule._id.toString()}`,
	}).catch(() => undefined);
}

/** Drive the conversation route as the schedule's owner. */
async function driveTurn(input: {
	user: User;
	token: string | undefined;
	scheduleId: ObjectId;
	conversationId: ObjectId;
	parentMessageId: string | undefined;
	text: string;
	timezone: string;
}): Promise<Response> {
	const { POST } = await import("../../../routes/conversation/[id]/+server");
	const form = new FormData();
	form.set(
		"data",
		JSON.stringify({
			inputs: input.text,
			...(input.parentMessageId ? { id: input.parentMessageId } : {}),
			timezone: input.timezone,
		})
	);
	const locals: App.Locals = {
		sessionId: `schedule:${input.scheduleId.toString()}`,
		user: input.user,
		isAdmin: false,
		...(input.token ? { token: input.token } : {}),
		timezone: input.timezone,
		scheduledRun: true,
	};
	const request = new Request(`http://localhost/conversation/${input.conversationId}`, {
		method: "POST",
		body: form,
	});
	return POST({
		request,
		locals,
		params: { id: input.conversationId.toString() },
		// Its own bucket: the per-address limit must not be shared with every other schedule.
		getClientAddress: () => `schedule:${input.user._id.toString()}`,
	} as unknown as Parameters<typeof POST>[0]);
}

async function createChatFor(input: {
	user: User;
	token: string | undefined;
	scheduleId: ObjectId;
	model: string;
	projectId?: string;
	title: string;
}): Promise<ObjectId> {
	const { POST } = await import("../../../routes/conversation/+server");
	const locals: App.Locals = {
		sessionId: `schedule:${input.scheduleId.toString()}`,
		user: input.user,
		isAdmin: false,
		...(input.token ? { token: input.token } : {}),
	};
	const response = await POST({
		locals,
		request: new Request("http://localhost/conversation", {
			method: "POST",
			body: JSON.stringify({
				model: input.model,
				...(input.projectId ? { projectId: input.projectId } : {}),
			}),
		}),
	} as unknown as Parameters<typeof POST>[0]);
	const body = (await response.json()) as { conversationId?: string };
	const id = objectId(body.conversationId);
	if (!id) throw new Error("The new chat could not be made.");
	await collections.conversations.updateOne({ _id: id }, { $set: { title: input.title } });
	return id;
}

function httpMessage(err: unknown): { status?: number; message: string } {
	const e = err as { status?: unknown; body?: { message?: unknown }; message?: unknown };
	const message =
		typeof e?.body?.message === "string"
			? e.body.message
			: err instanceof Error
				? err.message
				: String(err);
	return { ...(typeof e?.status === "number" ? { status: e.status } : {}), message };
}

registerExecutor({
	kind: "chat",

	async validateTarget(input, { userId, token }) {
		const target = parseChatTarget(input);
		if (!target) {
			return {
				ok: false,
				error: "Choose a chat to continue, or a model for a new chat each time.",
			};
		}
		const conv = await ownedConversation(userId, target.conversationId);
		if (target.conversationId && !conv)
			return { ok: false, error: "That chat is not one of yours." };
		target.labels = {};
		if (conv) target.labels.conversation = conv.title;

		if (target.mode === "new") {
			// The chat is a template: the model and project it has are the defaults.
			if (!target.model && conv?.model) target.model = conv.model;
			if (!target.projectId && conv?.projectId) target.projectId = conv.projectId.toString();
			if (!target.model) return { ok: false, error: "Choose a model for the new chats." };
			const owner = { userId };
			if (
				!(await isSelectableModel(
					target.model,
					owner,
					(id) => validateModel(models).safeParse(id).success
				))
			) {
				return { ok: false, error: "That model is not available." };
			}
			if (target.projectId) {
				const name = await projectLabel(userId, target.projectId, token);
				if (name === null) return { ok: false, error: "That project is not available to you." };
				target.labels.project = name;
			}
			// The conversation only seeded the defaults; the schedule does not hang on it.
			delete target.conversationId;
			delete target.labels.conversation;
		} else {
			delete target.model;
			delete target.projectId;
		}
		if (target.billingGroupId && !UUIDISH.test(target.billingGroupId)) {
			return { ok: false, error: "That is not a billing group id." };
		}
		return { ok: true, target };
	},

	async describeTarget(stored, { userId }) {
		const target = parseChatTarget(stored);
		if (!target) return "";
		if (target.mode === "continue") {
			const conv = await ownedConversation(userId, target.conversationId);
			return `Chat › ${conv?.title ?? target.labels.conversation ?? "chat"}`;
		}
		return ["New chat each time", target.labels.project].filter(Boolean).join(" › ");
	},

	async mintCredential({ userId, name, target, token }) {
		// Off a gateway there is no per-person key to make: the deployment's credential serves the turn.
		if (!isGatewayPreset()) return undefined;
		if (!token) throw new CredentialError(403, "Sign in again, then turn the schedule on.");
		// Before the gateway makes a key there would be nowhere safe to keep.
		if (!sealingAvailable()) {
			throw new CredentialError(
				400,
				"This deployment cannot keep the schedule's key safe: its administrator has to set CHAT_SECRET_KEY."
			);
		}
		const parsed = parseChatTarget(target);
		let billingGroupId = parsed?.billingGroupId;
		if (!billingGroupId) {
			const settings = await collections.settings.findOne({ userId });
			const preferred = settings?.billingOrganization?.trim();
			if (preferred && UUIDISH.test(preferred)) billingGroupId = preferred;
		}
		const key = await mintKey({
			token,
			name: `Cerea schedule: ${name}`,
			...(billingGroupId ? { billingGroupId } : {}),
			expiresInDays: KEY_LIFETIME_DAYS,
		});
		const mintedAt = new Date();
		return {
			keyId: key.id,
			sealed: seal(key.secret),
			...(billingGroupId ? { billingGroupId } : {}),
			mintedAt,
			expiresAt: new Date(mintedAt.getTime() + KEY_LIFETIME_DAYS * DAY_MS),
		};
	},

	credentialStale(before, after) {
		return parseChatTarget(before)?.billingGroupId !== parseChatTarget(after)?.billingGroupId;
	},

	async releaseCredential(schedule, { token }) {
		// Revokes with the person's session when there is one, else the key itself; what
		// cannot be confirmed is queued and retried (`credentials.ts`), never lost.
		if (schedule.credential) await revokeOrQueue(schedule.credential, schedule.userId, token);
	},

	async maintain(now) {
		await retryRevocations(now);
		await renewKeys(now);
	},

	async run({ schedule, now, previousRun }): Promise<ExecutorOutcome> {
		const target = parseChatTarget(schedule.target);
		if (!target) return { status: "failed", detail: "The schedule's target is not valid." };

		const user = await collections.users.findOne({ _id: schedule.userId });
		if (!user) {
			return {
				status: "failed",
				detail: "The account no longer exists.",
				disable: "The account no longer exists, so the schedule was switched off.",
			};
		}

		let token: string | undefined;
		if (isGatewayPreset()) {
			if (!schedule.credential) {
				return { status: "failed", detail: SIGN_IN_AGAIN, disable: SIGN_IN_AGAIN };
			}
			try {
				token = open(schedule.credential.sealed);
			} catch (err) {
				logger.warn({ err }, "scheduled_chat_key_unreadable");
				return {
					status: "failed",
					detail: SIGN_IN_AGAIN,
					disable: SIGN_IN_AGAIN,
					dropCredential: true,
				};
			}
		}

		// Which conversation, and is its last turn over.
		let conversationId: ObjectId | null = null;
		let parentMessageId: string | undefined;
		let conversationTitle = target.labels.conversation ?? "chat";
		if (target.mode === "continue") {
			const conv = await ownedConversation(schedule.userId, target.conversationId);
			if (!conv) {
				return {
					status: "failed",
					detail: "The chat this schedule posts into no longer exists.",
					disable:
						"The chat this schedule posts into was deleted, so the schedule was switched off.",
				};
			}
			conversationId = conv._id;
			conversationTitle = conv.title;
			parentMessageId = conv.messages.at(-1)?.id;
		}
		const busyId =
			conversationId ?? objectId(previousRun?.result?.ids["conversationId"]) ?? undefined;
		if (busyId && (await conversationBusy(busyId, now))) {
			return {
				status: "skipped-still-running",
				detail: "The previous turn is still generating.",
				result: {
					type: "chat",
					ids: { conversationId: busyId.toString() },
					label: conversationTitle,
				},
			};
		}

		if (target.mode === "new") {
			if (!target.model) return { status: "failed", detail: "The schedule's target is not valid." };
			if (target.projectId) {
				// Access is the person's as of now, not as of when the schedule was made.
				const still = await projectLabel(schedule.userId, target.projectId, token);
				if (still === null) {
					const lost =
						"You no longer have access to this schedule's project, so it was switched off.";
					return { status: "failed", detail: lost, disable: lost };
				}
			}
			try {
				conversationTitle = `${schedule.name} · ${runStamp(now, schedule.timezone)}`.slice(0, 100);
				conversationId = await createChatFor({
					user,
					token,
					scheduleId: schedule._id,
					model: target.model,
					projectId: target.projectId,
					title: conversationTitle,
				});
			} catch (err) {
				const { status, message } = httpMessage(err);
				if (status === 401 || status === 403) {
					if (status === 403 && /project/i.test(message)) {
						return { status: "failed", detail: message };
					}
					return {
						status: "failed",
						detail: SIGN_IN_AGAIN,
						disable: SIGN_IN_AGAIN,
						dropCredential: true,
					};
				}
				return { status: "failed", detail: `Starting the chat: ${message}` };
			}
			parentMessageId = undefined;
			const fresh = await collections.conversations.findOne(
				{ _id: conversationId },
				{ projection: { messages: 1 } }
			);
			parentMessageId = fresh?.messages.at(-1)?.id;
		}
		if (!conversationId) return { status: "failed", detail: "No chat to post into." };

		const result = {
			type: "chat",
			ids: { conversationId: conversationId.toString() },
			label: conversationTitle,
		};
		const text = `${scheduledChatHeader({
			name: schedule.name,
			recurrence: schedule.recurrence,
			timezone: schedule.timezone,
			previousRunAt: previousRun?.firedAt,
			now,
		})}\n\n${schedule.prompt}`;

		if (runningTurns >= chatRunConfig.maxConcurrent) {
			return {
				status: "skipped-still-running",
				detail: "Too many scheduled chats were running at once, so this run was skipped.",
				result,
			};
		}
		let response: Response;
		runningTurns += 1;
		try {
			response = await driveTurn({
				user,
				token,
				scheduleId: schedule._id,
				conversationId,
				parentMessageId,
				text,
				timezone: schedule.timezone,
			});
		} catch (err) {
			runningTurns -= 1;
			const { status, message } = httpMessage(err);
			if (status === 401) {
				return {
					status: "failed",
					detail: SIGN_IN_AGAIN,
					disable: SIGN_IN_AGAIN,
					dropCredential: true,
					result,
				};
			}
			return { status: "failed", detail: message, result };
		}

		const turn = readTurn(response).finally(() => {
			runningTurns -= 1;
		});
		const early = await Promise.race([
			turn,
			new Promise<null>((resolve) => {
				const timer = setTimeout(() => resolve(null), chatRunConfig.earlyWindowMs);
				timer.unref?.();
			}),
		]);

		if (early === null) {
			// Still generating: this run is sent. If the turn then fails, the core rewrites the run
			// and counts it (`settled`); either way its end is announced (unread mark, push).
			const settled = turn.then(async (report) => {
				await announce(schedule, conversationId, report, { push: !report.error });
				if (!report.error) return undefined;
				return refusedByGateway(report)
					? {
							status: "failed" as const,
							detail: SIGN_IN_AGAIN,
							disable: SIGN_IN_AGAIN,
							dropCredential: true,
						}
					: { status: "failed" as const, detail: report.error.message };
			});
			return {
				status: "sent",
				result,
				settled,
				detail: `Posted to "${conversationTitle}"; the answer is still coming.`,
			};
		}
		if (early.error) {
			await announce(schedule, conversationId, early, { push: false });
			if (refusedByGateway(early)) {
				return {
					status: "failed",
					detail: SIGN_IN_AGAIN,
					disable: SIGN_IN_AGAIN,
					dropCredential: true,
					result,
				};
			}
			return { status: "failed", detail: early.error.message, result };
		}
		await announce(schedule, conversationId, early, { push: true });
		return { status: "sent", result, detail: `Answered in "${conversationTitle}".` };
	},
});

/** Renew keys that end within `RENEW_BEFORE_DAYS`, with the person's latest session when one is still good. */
export async function renewKeys(now: Date = new Date()): Promise<number> {
	const horizon = new Date(now.getTime() + RENEW_BEFORE_DAYS * DAY_MS);
	const due = await collections.schedules
		.find({ kind: "chat", enabled: true, "credential.expiresAt": { $lte: horizon } })
		.limit(20)
		.toArray();
	const executor = getExecutor("chat");
	let renewed = 0;
	for (const schedule of due) {
		const old = schedule.credential;
		if (!old || !executor?.mintCredential) continue;
		const token = await sessionTokenFor(schedule.userId);
		// Nobody signed in who could make a key: the run that finds this one dead says to sign in again.
		if (!token) continue;
		let fresh;
		try {
			fresh = await executor.mintCredential({
				userId: schedule.userId,
				name: schedule.name,
				target: schedule.target,
				token,
			});
		} catch (err) {
			logger.warn({ err, scheduleId: schedule._id.toString() }, "scheduled_chat_key_renew_failed");
			continue;
		}
		if (!fresh) continue;
		const swapped = await collections.schedules.updateOne(
			{ _id: schedule._id, "credential.keyId": old.keyId },
			{ $set: { credential: fresh, updatedAt: new Date() } }
		);
		if (swapped.matchedCount === 0) {
			// The row changed under us: the key just made is nobody's.
			await revokeOrQueue(fresh, schedule.userId, token);
			continue;
		}
		await revokeOrQueue(old, schedule.userId, token);
		renewed += 1;
	}
	return renewed;
}
