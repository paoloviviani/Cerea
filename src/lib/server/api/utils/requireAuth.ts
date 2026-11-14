import { error } from "@sveltejs/kit";

/**
 * Throws 401 if neither a user._id nor sessionId is present in locals.
 */
export function requireAuth(locals: App.Locals): void {
	if (!locals.user?._id && !locals.sessionId) {
		error(401, "Must have a valid session or user");
	}
}

/**
 * Throws 401 if no user/session, 403 if not admin.
 */
export function requireAdmin(locals: App.Locals): void {
	if (!locals.user && !locals.sessionId) {
		error(401, "Unauthorized");
	}
	if (!locals.isAdmin) {
		error(403, "Admin privileges required");
	}
}

/**
 * Throws 401 unless a signed-in user is present: an anonymous session is not enough, for
 * things that have nowhere durable to live without an account (chat notes).
 */
export function requireUser(locals: App.Locals): void {
	if (!locals.user?._id) {
		error(401, "Login required");
	}
}
