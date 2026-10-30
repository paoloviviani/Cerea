import type { RequestHandler } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import {
	disableChatSchedules,
	hasGrant,
	scheduleGrantUsable,
	stopScheduleUse,
} from "$lib/server/schedules/grants";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";

const REVOKED_REASON =
	"Background access was stopped. Turn the schedule back on to let it run while you are away again.";

/** Whether the person has given scheduled chats background access, and what depends on it. */
export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	return superjsonResponse({
		// Off a gateway there is nothing to grant: schedules need no per-person token.
		required: isGatewayPreset(),
		// The sign-in left a grant (turning a chat schedule on can use it again) ...
		granted: await hasGrant(locals.user._id),
		// ... and whether scheduled chats are using it now.
		active: await scheduleGrantUsable(locals.user._id),
		chatSchedules: await collections.schedules.countDocuments({
			userId: locals.user._id,
			kind: "chat",
		}),
	});
};

/**
 * Stop background access for schedules: the person's chat schedules switch off and stop using the grant. The
 * grant itself stays (it is what keeps their sessions signed in); turning a chat schedule on, or signing in
 * again, gives it back.
 */
export const DELETE: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	await stopScheduleUse(locals.user._id);
	const disabled = await disableChatSchedules(locals.user._id, REVOKED_REASON);
	return superjsonResponse({ revoked: true, disabled });
};
