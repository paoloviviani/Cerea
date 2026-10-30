/**
 * A chat schedule's permission mode, copying /code schedules' Ask / Allow word.
 *
 * `ask`: a scheduled run refuses every tool that needs approval (nobody is there to approve one).
 * `allow`: such tools run as they would for the person (their "always allow" policy, and what the
 * chat already approved); only what would still need a click is refused. A mode is **never looser
 * than the person's own tool-approval policy**: a user on manual cannot make an `allow` schedule,
 * and the default for a new one is their policy.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";

export type SchedulePermission = "ask" | "allow";

/** The person's tool-approval policy as saved in their settings (default: manual). */
export async function userApprovalPolicy(userId: ObjectId): Promise<"always-allow" | "manual"> {
	const settings = await collections.settings.findOne(
		{ userId },
		{ projection: { toolApprovalPolicy: 1 } }
	);
	return settings?.toolApprovalPolicy ?? "manual";
}

/** The loosest mode a policy allows. */
export function ceilingFor(policy: "always-allow" | "manual"): SchedulePermission {
	return policy === "always-allow" ? "allow" : "ask";
}

/** `requested` no looser than the policy allows; absent takes the policy's own mode. */
export function clampPermission(
	requested: SchedulePermission | undefined,
	policy: "always-allow" | "manual"
): SchedulePermission {
	const ceiling = ceilingFor(policy);
	if (!requested) return ceiling;
	return requested === "allow" && ceiling === "ask" ? "ask" : requested;
}
