import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { deleteTicketsOf } from "./tickets";

/**
 * The user's switch for relayed coordination (ADR 0121 section 9): `Settings.relayedCoordinationEnabled`,
 * on unless the stored value is `false`. Read on every `coord.*` call, so a toggle takes effect at once,
 * for a card already waiting too (its ticket is checked at call time against the current switch).
 */
export async function relayedCoordinationOn(userId: ObjectId): Promise<boolean> {
	const settings = await collections.settings.findOne(
		{ userId },
		{ projection: { relayedCoordinationEnabled: 1 } }
	);
	return settings?.relayedCoordinationEnabled !== false;
}

/**
 * The switch just changed. Turning it off deletes the user's open tickets; either way one audit
 * row `coord.switch` says which way, with no computer: the switch is the user's.
 */
export async function onRelaySwitchChanged(userId: ObjectId, on: boolean): Promise<void> {
	if (!on) await deleteTicketsOf(userId);
	await recordCodeAuditRow(userId, {
		action: "coord.switch",
		origin: "user",
		outcome: on ? "on" : "off",
	});
}
