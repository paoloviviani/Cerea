import { error } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";

/**
 * Settings rows keyed by a bare session id (a visitor on a deployment with no sign-in). The cookie
 * is the client's to mint, so creating one is bounded: a global cap, and a per-address allowance
 * per hour (in process, like the app's other limiters). Every route that may upsert such a row
 * goes through `guardAnonymousSettingsRow` first. Deployments exposed to the internet should sit
 * behind sign-in or the proxy's own rate limit; these bounds only stop unbounded growth.
 */
export const ANON_SETTINGS_MAX_ROWS = 10_000;
export const ANON_ROWS_PER_IP_PER_HOUR = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const created = new Map<string, number[]>();
const touched = new Map<string, number>();
const MAX_TRACKED = 5_000;

export function _resetAnonymousSettingsState(): void {
	created.clear();
	touched.clear();
}

function overIpAllowance(ip: string, now: number): boolean {
	const recent = (created.get(ip) ?? []).filter((t) => now - t < HOUR);
	created.delete(ip);
	created.set(ip, recent);
	if (created.size > MAX_TRACKED) {
		for (const k of created.keys()) {
			if (created.size <= MAX_TRACKED / 2) break;
			created.delete(k);
		}
	}
	return recent.length >= ANON_ROWS_PER_IP_PER_HOUR;
}

/** Throws 429 when a new anonymous row may not be created; a no-op for a signed-in user or an existing row. */
export async function guardAnonymousSettingsRow(
	locals: App.Locals,
	ip: string | undefined,
	now = Date.now()
): Promise<void> {
	if (locals.user) return;
	if (!locals.sessionId) error(401, "Unauthorized");
	if (await collections.settings.countDocuments(authCondition(locals), { limit: 1 })) return;
	const who = ip ?? "unknown";
	if (overIpAllowance(who, now)) error(429, "Too many new sessions from this address");
	const total = await collections.settings.countDocuments(
		{ sessionId: { $exists: true } },
		{ limit: ANON_SETTINGS_MAX_ROWS }
	);
	if (total >= ANON_SETTINGS_MAX_ROWS) error(429, "Too many anonymous sessions");
	created.get(who)?.push(now);
}

/**
 * An anonymous visitor in use keeps their row: the TTL index counts from `updatedAt`, so it is
 * refreshed here, at most once a day per session, while their cookie keeps coming back.
 */
export async function touchAnonymousSettings(sessionId: string, now = Date.now()): Promise<void> {
	const last = touched.get(sessionId);
	if (last !== undefined && now - last < DAY) return;
	touched.delete(sessionId);
	touched.set(sessionId, now);
	if (touched.size > MAX_TRACKED) {
		for (const k of touched.keys()) {
			if (touched.size <= MAX_TRACKED / 2) break;
			touched.delete(k);
		}
	}
	await collections.settings.updateOne(
		{ sessionId, userId: { $exists: false }, updatedAt: { $lt: new Date(now - DAY) } },
		{ $set: { updatedAt: new Date(now) } }
	);
}
