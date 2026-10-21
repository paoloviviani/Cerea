/**
 * "Send a test notification": to every device the caller subscribed, whatever
 * the per-event switches say (they are asking), under the same rate limit as
 * everything else.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { sendTestNotification } from "$lib/server/push/notify";
import { pushPublicKey } from "$lib/server/push/vapid";

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, "Login required");
	if (!pushPublicKey()) error(404, "Push notifications are not set up on this deployment.");
	const result = await sendTestNotification(locals.user._id);
	if (result.skipped === "no-devices") error(409, "Turn notifications on for a device first.");
	if (result.skipped === "rate-limited")
		error(429, "Too many notifications just now. Try again in a few minutes.");
	return json({ data: result });
};
