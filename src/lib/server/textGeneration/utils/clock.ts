/**
 * What the model is told about time.
 *
 * Two things, both in the *user's* timezone (the IANA zone the browser sends
 * with each request, `locals.timezone`), because a model that is told "today
 * is Saturday" in the server's zone answers a person in another one wrongly
 * for a few hours each day:
 *
 * - `currentTimeLine`, the one line of the system prompt that says when it is
 *   now. Without it the model guesses its date from training data.
 * - `gapMarker`, a prefix on a user message that arrives long after the one
 *   before it, so a conversation picked up a week later does not read as one
 *   continuous sitting. It is built for the request and never stored.
 *
 * The zone is client-supplied and validated only as a string, and `Intl`
 * throws on one it does not know; every function here degrades to the
 * server's zone rather than failing the turn, and says so by not claiming a
 * zone it did not use.
 */

/** A gap this long or shorter is not worth a marker. */
export const GAP_MARKER_THRESHOLD_MS = 60 * 60 * 1000;

/** The first formatter that accepts `zone`, with the zone it actually used. */
function withZone<T>(zone: string | undefined, format: (zone: string | undefined) => T) {
	if (zone) {
		try {
			return { value: format(zone), zone };
		} catch {
			/* an unknown zone: fall through to the server's */
		}
	}
	return { value: format(undefined), zone: undefined };
}

/** `2026-10-04` for `now` in `zone` — not the server's calendar date. */
export function isoDateIn(now: Date, zone?: string): string {
	return withZone(zone, (z) =>
		new Intl.DateTimeFormat("en-CA", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			...(z ? { timeZone: z } : {}),
		}).format(now)
	).value;
}

/**
 * `Current date and time: Saturday, October 4, 2026 at 02:32 PM (2026-10-04).
 * User's timezone: Europe/Rome.` One line, stated once per prompt.
 */
export function currentTimeLine(now: Date, timezone?: string): string {
	const { value: text, zone } = withZone(timezone, (z) =>
		now.toLocaleString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
			weekday: "long",
			hour: "2-digit",
			minute: "2-digit",
			// Without a user zone the server's applies; name it, so the model
			// is not left to assume it is the person's.
			...(z ? { timeZone: z } : { timeZoneName: "short" }),
		})
	);
	const iso = isoDateIn(now, zone);
	return `Current date and time: ${text} (${iso}).${zone ? ` User's timezone: ${zone}.` : ""}`;
}

function spanOf(ms: number): string {
	const hours = Math.round(ms / (60 * 60 * 1000));
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `${days} days`;
}

/**
 * `(sent Sat 4 Oct 14:32, 3 hours after the previous message)` when `sentAt`
 * is more than an hour after `previousAt`, else null. Unreadable or reversed
 * timestamps give null: no marker beats a wrong one.
 */
export function gapMarker(
	previousAt: Date | string | number | undefined,
	sentAt: Date | string | number | undefined,
	timezone?: string
): string | null {
	if (previousAt === undefined || sentAt === undefined) return null;
	const before = new Date(previousAt).getTime();
	const after = new Date(sentAt).getTime();
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
	const gap = after - before;
	if (gap <= GAP_MARKER_THRESHOLD_MS) return null;
	const { value: parts } = withZone(timezone, (z) =>
		new Intl.DateTimeFormat("en-GB", {
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			...(z ? { timeZone: z } : {}),
		}).formatToParts(new Date(after))
	);
	const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return `(sent ${at("weekday")} ${at("day")} ${at("month")} ${at("hour")}:${at("minute")}, ${spanOf(gap)} after the previous message)`;
}
