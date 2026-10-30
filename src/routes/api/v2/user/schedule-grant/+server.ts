import type { RequestHandler } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import { dropGrant, disableChatSchedules, hasGrant } from "$lib/server/schedules/grants";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";

const REVOKED_REASON =
	"Background access was revoked. Turn the schedule back on to let it run while you are away again.";

/** Whether the person has given scheduled chats background access, and what depends on it. */
export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	return superjsonResponse({
		// Off a gateway there is nothing to grant: schedules need no per-person token.
		required: isGatewayPreset(),
		granted: await hasGrant(locals.user._id),
		chatSchedules: await collections.schedules.countDocuments({
			userId: locals.user._id,
			kind: "chat",
		}),
	});
};

/** Revoke it: the grant is dropped (and revoked at the identity provider when it can be), and the person's chat schedules switch off. */
export const DELETE: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	await dropGrant(locals.user._id);
	const disabled = await disableChatSchedules(locals.user._id, REVOKED_REASON);
	return superjsonResponse({ revoked: true, disabled });
};
