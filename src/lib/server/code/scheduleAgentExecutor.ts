/**
 * The "agent" executor for scheduled actions: a prompt sent to a coding
 * session on one of the person's paired machines, through the same
 * `MachineLink` ops the /code panel itself uses (`session.create`,
 * `session.setPermissionMode`, `session.prompt`), plus `session.grantCoordination`
 * when a schedule's coordination options are on (below).
 *
 * **Target** (stored, validated by `validateTarget`):
 * `{ deviceId, workspaceId, sessionMode: "new" | "existing", sessionId?,
 *    modeId?, modelId?, permissionMode, labels }`.
 * A device is the caller's own paired machine (any other id is refused as if
 * it did not exist). `labels` are the names shown in lists ("machine ›
 * workspace › session") so a list needs no live machine.
 *
 * **What a run does.** Revoked machine: the schedule is switched off.
 * Offline: `missed-offline`, nothing queued (the machine owns its sessions
 * and there is nowhere to queue). Then the workspace must still exist, else
 * `failed` with that reason. If the session the last run used (or the pinned
 * one) is still working or waiting on an approval: `skipped-still-running`.
 * Otherwise a new session is created (titled "<name> · <YYYY-MM-DD HH:mm>"
 * in the schedule's zone) or the pinned one is reused, its mode, model and
 * Deny / Ask / Allow word are set, and the prompt is sent.
 *
 * **Coordination.** Two options, both off by default: `canMessage` ("can
 * find, read and message other sessions": `session_list`, `session_read`,
 * `session_send`) and `canSpawn` ("can start new sessions": `session_spawn`).
 * After the session is created or chosen and before the prompt, the run
 * applies them with `session.grantCoordination`, so an unattended run can
 * orchestrate the machine's other sessions without stopping at an approval
 * card. The grant is never more than the machine allows: its ceiling still
 * caps a key, another workspace's sessions still ask, the hop and rate
 * limits stand. A machine whose galopin predates the op (no `coordinationGrant`
 * in its hello, or `unsupported`) runs the prompt without it and the run row
 * says so. A pinned session whose schedule has both options off has any grant
 * cleared (it may have been set by an earlier version of the schedule); a
 * new session each run has nothing to clear.
 *
 * **Permissions.** The word is applied to the run's session and the machine's
 * ceiling still caps it (galopin composes the ceiling last, PROTOCOL.md
 * §6). Unattended on Ask, a run stalls on its first approval card, which
 * surfaces in the Needs-you inbox. For an existing session the word is
 * **set on that session** and stays after the run: it is the same session.
 *
 * **Billing.** The machine pays with its own credential; Cerea only sends the
 * prompt.
 */

import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";
import { allowsModel } from "$lib/server/code/modelPolicy";
import { registerExecutor, type ExecutorOutcome } from "$lib/server/schedules/executors";
import { OpError, type Session } from "$lib/types/machineProtocol";
import { coordinationKeys, coordinationSupport, TOO_OLD_DETAIL } from "$lib/utils/coordination";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type { Schedule } from "$lib/types/Schedule";

const label = z.string().trim().max(160);

const targetSchema = z
	.object({
		deviceId: z.string().min(1).max(64),
		workspaceId: z.string().min(1).max(256),
		sessionMode: z.enum(["new", "existing"]),
		sessionId: z.string().min(1).max(256).optional(),
		modeId: z.string().min(1).max(64).optional(),
		modelId: z.string().min(1).max(256).optional(),
		permissionMode: z.enum(["deny", "ask", "allow"]),
		canMessage: z.boolean().optional(),
		canSpawn: z.boolean().optional(),
		labels: z
			.object({ machine: label.optional(), workspace: label.optional(), session: label.optional() })
			.optional(),
	})
	.refine((t) => (t.sessionMode === "existing") === Boolean(t.sessionId), {
		message: "Choose a session, or a new session each run.",
	});

export type AgentTarget = {
	deviceId: string;
	workspaceId: string;
	sessionMode: "new" | "existing";
	sessionId?: string;
	modeId?: string;
	modelId?: string;
	permissionMode: "deny" | "ask" | "allow";
	/** Coordination: find, read and message other sessions. Absent = off. */
	canMessage?: boolean;
	/** Coordination: start new sessions. Absent = off. */
	canSpawn?: boolean;
	labels: { machine: string; workspace: string; session?: string };
};

function parseTarget(target: unknown): AgentTarget | null {
	const parsed = targetSchema.safeParse(target);
	if (!parsed.success) return null;
	const t = parsed.data;
	return {
		deviceId: t.deviceId,
		workspaceId: t.workspaceId,
		sessionMode: t.sessionMode,
		...(t.sessionId ? { sessionId: t.sessionId } : {}),
		...(t.modeId ? { modeId: t.modeId } : {}),
		...(t.modelId ? { modelId: t.modelId } : {}),
		permissionMode: t.permissionMode,
		...(t.canMessage ? { canMessage: true } : {}),
		...(t.canSpawn ? { canSpawn: true } : {}),
		labels: {
			machine: t.labels?.machine ?? "",
			workspace: t.labels?.workspace ?? "",
			...(t.labels?.session ? { session: t.labels.session } : {}),
		},
	};
}

async function ownedDevice(userId: ObjectId, deviceId: string): Promise<CodeDevice | null> {
	let _id: ObjectId;
	try {
		_id = new ObjectId(deviceId);
	} catch {
		return null;
	}
	return collections.codeDevices.findOne({ _id, userId });
}

/** "2026-10-08 09:00" in the schedule's own zone. */
export function runStamp(at: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(at);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function sessionTitle(schedule: Schedule, at: Date): string {
	return `${schedule.name} · ${runStamp(at, schedule.timezone)}`.slice(0, 120);
}

function busyReason(session: Session): string | null {
	if (session.pendingPermissions > 0) return "is waiting for an approval";
	if (session.status === "busy" || session.status === "retry") return "is still working";
	return null;
}

function failedFrom(err: unknown, what: string): ExecutorOutcome {
	if (err instanceof OpError) {
		if (err.code === "unavailable") {
			return { status: "missed-offline", detail: `The machine went offline while ${what}.` };
		}
		return { status: "failed", detail: `${what}: ${err.message}` };
	}
	return {
		status: "failed",
		detail: `${what}: ${err instanceof Error ? err.message : String(err)}`,
	};
}

registerExecutor({
	kind: "agent",
	available: () => codeAgentsEnabled(),

	async validateTarget(input, { userId }) {
		const target = parseTarget(input);
		if (!target) {
			return {
				ok: false,
				error:
					"Choose a machine and workspace, a session (or a new one each run) and a permission mode.",
			};
		}
		const device = await ownedDevice(userId, target.deviceId);
		if (!device) return { ok: false, error: "That machine is not one of yours." };
		if (device.status !== "paired") return { ok: false, error: "That machine is not paired." };
		if (target.modelId && !allowsModel(device, target.modelId)) {
			return { ok: false, error: "This machine was enrolled without --allow-free-models." };
		}
		target.labels.machine = device.name;

		// An offline machine can be chosen: it cannot be asked, so its names are
		// taken as given and the run is recorded missed-offline if it is still away.
		if (isMachineOnline(target.deviceId)) {
			const link = new MachineLink(target.deviceId);
			try {
				const { workspaces } = await link.workspaceList();
				const workspace = workspaces.find((w) => w.id === target.workspaceId);
				if (!workspace) return { ok: false, error: "That workspace is not on this machine." };
				target.labels.workspace = workspace.name;
				if (target.sessionMode === "existing" && target.sessionId) {
					const { session } = await link.sessionGet({ sessionId: target.sessionId });
					if (session.workspaceId !== target.workspaceId || session.parentId) {
						return { ok: false, error: "That session is not a session of this workspace." };
					}
					target.labels.session = session.title;
				}
			} catch (err) {
				if (err instanceof OpError && err.code === "not_found") {
					return { ok: false, error: "That session is not on this machine." };
				}
				if (!(err instanceof OpError && err.code === "unavailable")) {
					return { ok: false, error: err instanceof Error ? err.message : "The machine refused." };
				}
			}
		}
		if (target.sessionMode === "new") delete target.labels.session;
		return { ok: true, target };
	},

	async describeTarget(stored) {
		const target = parseTarget(stored);
		if (!target) return "";
		const session =
			target.sessionMode === "new" ? "new session" : (target.labels.session ?? "session");
		return [
			target.labels.machine || "machine",
			target.labels.workspace || "workspace",
			session,
		].join(" › ");
	},

	async run({ schedule, now, previousRun }) {
		const target = parseTarget(schedule.target);
		if (!target) return { status: "failed", detail: "The schedule's target is not valid." };

		const device = await ownedDevice(schedule.userId, target.deviceId);
		if (!device || device.status !== "paired") {
			return {
				status: "failed",
				detail: "The machine has been revoked or removed.",
				disable: "This machine was revoked or removed, so the schedule was switched off.",
			};
		}
		if (!isMachineOnline(target.deviceId)) {
			return { status: "missed-offline", detail: `${device.name} was offline.` };
		}
		const link = new MachineLink(target.deviceId);
		const where = target.labels.workspace || "the workspace";

		try {
			const { workspaces } = await link.workspaceList();
			if (!workspaces.some((w) => w.id === target.workspaceId)) {
				return {
					status: "failed",
					detail: `The workspace "${where}" no longer exists on ${device.name}.`,
				};
			}
		} catch (err) {
			return failedFrom(err, "listing the machine's workspaces");
		}

		// Overlap: the session this run would use (the pinned one, or the one the
		// last run created) is still going.
		let existing: Session | null = null;
		const candidateId =
			target.sessionMode === "existing" ? target.sessionId : previousRun?.result?.ids.sessionId;
		if (candidateId) {
			try {
				const { session } = await link.sessionGet({ sessionId: candidateId });
				if (target.sessionMode === "existing") existing = session;
				const busy = busyReason(session);
				if (busy) {
					return {
						status: "skipped-still-running",
						detail: `"${session.title}" ${busy}.`,
						result: {
							type: "agent-session",
							ids: {
								deviceId: target.deviceId,
								workspaceId: target.workspaceId,
								sessionId: session.id,
							},
							label: session.title,
						},
					};
				}
			} catch (err) {
				if (err instanceof OpError && err.code === "not_found") {
					// A pinned session that is gone is the person's to fix; a previous
					// run's session that is gone just means there is nothing to wait for.
					if (target.sessionMode === "existing") {
						return {
							status: "failed",
							detail: `The session "${target.labels.session ?? candidateId}" no longer exists.`,
						};
					}
				} else {
					return failedFrom(err, "checking the previous session");
				}
			}
		}

		let session: Session;
		try {
			if (target.sessionMode === "existing" && existing) {
				session = existing;
				if (target.modeId && session.modeId !== target.modeId) {
					session = (await link.sessionSetMode({ sessionId: session.id, modeId: target.modeId }))
						.session;
				}
				if (target.modelId && session.modelId !== target.modelId) {
					session = (await link.sessionSetModel({ sessionId: session.id, modelId: target.modelId }))
						.session;
				}
			} else {
				session = (
					await link.sessionCreate({
						workspaceId: target.workspaceId,
						title: sessionTitle(schedule, now),
						// The panel's own default when none is chosen.
						modeId: target.modeId ?? "plan",
						...(target.modelId ? { modelId: target.modelId } : {}),
					})
				).session;
			}
		} catch (err) {
			return failedFrom(err, "creating the session");
		}

		const result = {
			type: "agent-session",
			ids: { deviceId: target.deviceId, workspaceId: target.workspaceId, sessionId: session.id },
			label: session.title,
		};
		let coordination = "";
		try {
			if (session.permissionMode !== target.permissionMode) {
				try {
					await link.sessionSetPermissionMode({
						sessionId: session.id,
						mode: target.permissionMode,
					});
				} catch (err) {
					// A machine that predates the selector starts every session on Ask:
					// only that word can be left unset. Anything looser must not run.
					const unsupported = err instanceof OpError && err.code === "unsupported";
					if (!(unsupported && target.permissionMode === "ask")) throw err;
				}
			}
		} catch (err) {
			return { ...failedFrom(err, "setting the permission mode"), result };
		}
		try {
			coordination = await applyCoordination(link, device, target, session.id);
		} catch (err) {
			return { ...failedFrom(err, "granting coordination"), result };
		}
		try {
			await link.sessionPrompt({
				sessionId: session.id,
				text: schedule.prompt,
				clientMessageId: randomUUID(),
			});
		} catch (err) {
			const outcome = failedFrom(err, "sending the prompt");
			return { ...outcome, result };
		}
		const word =
			target.permissionMode === "ask"
				? "Ask"
				: target.permissionMode === "allow"
					? "Allow"
					: "Deny";
		return {
			status: "sent",
			result,
			detail: `Sent to "${session.title}" with ${word} permissions${coordination}`,
		};
	},
});

/**
 * Grant (or clear) the session's coordination tools before the prompt, and
 * say what happened as the tail of the run row's detail: "." when nothing
 * was asked, a sentence when it was granted, and the plain reason when it
 * could not be. A machine that cannot take a grant is not an error: the run
 * goes ahead without it.
 */
async function applyCoordination(
	link: MachineLink,
	device: CodeDevice,
	target: AgentTarget,
	sessionId: string
): Promise<string> {
	const keys = coordinationKeys(target);
	const support = coordinationSupport(device);
	if (keys.length === 0) {
		// Nothing asked. A pinned session may still carry a grant an earlier version
		// of this schedule gave it: take it back, so turning the options off means off.
		if (target.sessionMode === "existing" && support.ok) {
			try {
				await link.sessionGrantCoordination({ sessionId, keys: [] });
			} catch (err) {
				if (!(err instanceof OpError && err.code === "unsupported")) throw err;
			}
		}
		return ".";
	}
	if (!support.ok) return `, but ${support.detail}.`;
	try {
		await link.sessionGrantCoordination({ sessionId, keys });
	} catch (err) {
		if (err instanceof OpError && err.code === "unsupported") {
			return `, but ${TOO_OLD_DETAIL}.`;
		}
		throw err;
	}
	const can = [
		...(target.canMessage ? ["find, read and message other sessions"] : []),
		...(target.canSpawn ? ["start new sessions"] : []),
	];
	return `. It may ${can.join(" and ")}, within what the machine allows.`;
}

/**
 * A machine was revoked: switch off every schedule that points at it now,
 * rather than at the next run. The run-time check stays as the backstop.
 */
export async function disableSchedulesForDevice(
	userId: ObjectId | undefined,
	deviceId: string
): Promise<number> {
	if (!userId) return 0;
	const { modifiedCount } = await collections.schedules.updateMany(
		{ userId, kind: "agent", enabled: true, "target.deviceId": deviceId },
		{
			$set: {
				enabled: false,
				nextRunAt: null,
				disabledReason: "This machine was revoked, so the schedule was switched off.",
				updatedAt: new Date(),
			},
		}
	);
	return modifiedCount;
}
