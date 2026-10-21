import type { RequestEvent } from "@sveltejs/kit";

/**
 * The parts of a request that are safe to write to the logs. `event.locals`
 * carries the bearer access token, the session id and the whole user record,
 * and `event.request` carries the cookie and authorization headers, so none
 * of them may be handed to the logger as a whole. Log these instead.
 */
export function safeRequestFields(
	event: Pick<RequestEvent, "locals" | "route" | "url" | "params">
) {
	const { user, isAdmin } = event.locals;
	return {
		user: user ? { id: String(user._id), username: user.username } : undefined,
		isAdmin,
		routeId: event.route?.id ?? null,
		url: event.url.pathname,
		params: event.params,
	};
}
