/**
 * When a user saves their Auto rows (Workspace -> Agents), the new per-class map reaches their
 * sessions that are on Auto right now, on the machines that are connected, so the new rows take
 * effect without re-selecting Auto. An offline machine's sessions keep the old map until Auto is
 * next applied to them (the map is the session's, held by galopin).
 */
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { autoClassesFor } from "$lib/server/agentReview";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";

export interface ResendDeps {
	devices: (userId: ObjectId) => Promise<string[]>;
	online: (deviceId: string) => boolean;
	link: (deviceId: string) => Pick<MachineLink, "sessionList" | "sessionSetPermissionMode">;
}

const realDeps: ResendDeps = {
	devices: async (userId) =>
		(await collections.codeDevices.find({ userId, status: "paired" }).toArray()).map((d) =>
			String(d._id)
		),
	online: isMachineOnline,
	link: (id) => new MachineLink(id),
};

/** Returns how many sessions were updated. Never throws: the save has already happened. */
export async function resendAutoMap(
	userId: ObjectId,
	deps: ResendDeps = realDeps
): Promise<number> {
	let updated = 0;
	try {
		const map = await autoClassesFor(userId);
		const wanted = JSON.stringify(map);
		for (const deviceId of await deps.devices(userId)) {
			if (!deps.online(deviceId)) continue;
			try {
				const link = deps.link(deviceId);
				const { sessions } = await link.sessionList();
				for (const s of sessions) {
					// Roots only (a subagent follows its root); only sessions on Auto now.
					if (s.parentId || s.permissionMode !== "ask" || !s.autoClasses) continue;
					if (JSON.stringify(s.autoClasses) === wanted) continue;
					await link.sessionSetPermissionMode({
						sessionId: s.id,
						mode: "ask",
						autoClasses: map,
					});
					updated += 1;
				}
			} catch (err) {
				logger.warn(
					{ err: String(err), deviceId },
					"review: could not refresh Auto rows on a machine"
				);
			}
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "review: could not refresh Auto rows");
	}
	return updated;
}
