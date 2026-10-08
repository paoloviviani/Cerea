/**
 * When a schedule runs: validation of what a person typed, and the next
 * occurrence after an instant. Pure — no database, no clock of its own.
 *
 * **The cron library is `croner`** (MIT, no dependencies, maintained, 10.x).
 * It does the one hard part, wall-clock time in an IANA zone across DST, and
 * everything wall-clock here goes through it: the presets are written as the
 * cron expression they mean (`daily 09:00` is `0 9 * * *`). Its DST rules,
 * which `recurrence.spec.ts` pins: a time the clock skips (02:30 on a
 * spring-forward day) runs once, at the first instant that exists (03:30);
 * a time the clock repeats (02:30 on a fall-back day, or the 01:00 hour)
 * runs once, at the first of the two.
 *
 * "Every N hours" is not wall-clock: it is N elapsed hours counted from
 * `anchorAt`, which is what people mean by it and which cron cannot express
 * for an N that does not divide 24.
 *
 * **The floor is 15 minutes**, enforced here and nowhere else: a preset can
 * never be that fast, a cron expression is sampled and refused if any two of
 * its next occurrences are closer than `MIN_INTERVAL_MS`. Cron's seconds field
 * (six or seven parts) is refused outright.
 */

import { Cron } from "croner";
import { z } from "zod";
import type { Recurrence } from "$lib/types/Schedule";

export const MIN_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** "Every N hours": up to a month. A longer period is a cron expression. */
export const MAX_EVERY_HOURS = 24 * 30;
/** How many upcoming occurrences a cron expression is checked against the floor over. */
const FLOOR_SAMPLE = 400;
const MAX_CRON_LENGTH = 120;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const recurrenceSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hours"), every: z.number().int() }),
	z.object({ type: z.literal("daily"), at: z.string() }),
	z.object({ type: z.literal("weekdays"), at: z.string() }),
	z.object({ type: z.literal("weekly"), day: z.number().int(), at: z.string() }),
	z.object({ type: z.literal("cron"), expr: z.string() }),
]);

export function isValidTimezone(timezone: string): boolean {
	if (!timezone || timezone.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/** The cron expression a wall-clock preset stands for; null for "hours". */
export function cronExpressionOf(recurrence: Recurrence): string | null {
	switch (recurrence.type) {
		case "hours":
			return null;
		case "cron":
			return recurrence.expr.trim().replace(/\s+/g, " ");
		case "daily":
		case "weekdays":
		case "weekly": {
			const [hh, mm] = recurrence.at.split(":").map(Number);
			const days =
				recurrence.type === "daily" ? "*" : recurrence.type === "weekdays" ? "1-5" : recurrence.day;
			return `${mm} ${hh} * * ${days}`;
		}
	}
}

function cronOf(expr: string, timezone: string): Cron {
	return new Cron(expr, { timezone });
}

export type RecurrenceCheck = { ok: true; recurrence: Recurrence } | { ok: false; error: string };

/** Check a recurrence a person supplied, against the floor, in `timezone`. */
export function validateRecurrence(
	input: unknown,
	timezone: string,
	now: Date = new Date()
): RecurrenceCheck {
	const parsed = recurrenceSchema.safeParse(input);
	if (!parsed.success) return { ok: false, error: "Choose how often this runs." };
	const recurrence = parsed.data;
	switch (recurrence.type) {
		case "hours":
			if (recurrence.every < 1 || recurrence.every > MAX_EVERY_HOURS) {
				return { ok: false, error: `Every N hours needs N from 1 to ${MAX_EVERY_HOURS}.` };
			}
			return { ok: true, recurrence };
		case "weekly":
			if (recurrence.day < 0 || recurrence.day > 6) {
				return { ok: false, error: "Pick a day of the week." };
			}
		// falls through to the time check
		case "daily":
		case "weekdays":
			if (!TIME.test(recurrence.at)) return { ok: false, error: "The time must be HH:MM." };
			return { ok: true, recurrence };
		case "cron": {
			const expr = recurrence.expr.trim().replace(/\s+/g, " ");
			if (!expr || expr.length > MAX_CRON_LENGTH) {
				return { ok: false, error: "Enter a cron expression of five fields." };
			}
			// `@daily` and friends are one token; anything else is five fields
			// exactly — six or seven would add a seconds field below the floor.
			const parts = expr.split(" ");
			if (!(parts.length === 1 && expr.startsWith("@")) && parts.length !== 5) {
				return {
					ok: false,
					error: "A cron expression has five fields: minute hour day month weekday.",
				};
			}
			let cron: Cron;
			try {
				cron = cronOf(expr, timezone);
			} catch (err) {
				return {
					ok: false,
					error: `That cron expression is not valid: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			const runs = cron.nextRuns(FLOOR_SAMPLE, now);
			if (runs.length === 0) return { ok: false, error: "That cron expression never runs." };
			for (let i = 1; i < runs.length; i++) {
				if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MS) {
					return {
						ok: false,
						error: "Runs must be at least 15 minutes apart; that expression fires sooner.",
					};
				}
			}
			return { ok: true, recurrence: { type: "cron", expr } };
		}
	}
}

/** The first occurrence strictly after `after`, or null if there is none. */
export function nextOccurrence(
	recurrence: Recurrence,
	timezone: string,
	after: Date,
	anchorAt: Date
): Date | null {
	if (recurrence.type === "hours") {
		const step = recurrence.every * HOUR_MS;
		const k = Math.max(1, Math.floor((after.getTime() - anchorAt.getTime()) / step) + 1);
		return new Date(anchorAt.getTime() + k * step);
	}
	const expr = cronExpressionOf(recurrence);
	if (!expr) return null;
	return cronOf(expr, timezone).nextRun(after);
}

export function nextOccurrences(
	recurrence: Recurrence,
	timezone: string,
	after: Date,
	anchorAt: Date,
	count: number
): Date[] {
	const out: Date[] = [];
	let cursor = after;
	for (let i = 0; i < count; i++) {
		const next = nextOccurrence(recurrence, timezone, cursor, anchorAt);
		if (!next) break;
		out.push(next);
		cursor = next;
	}
	return out;
}

/** The gap from an occurrence to the one after it: what "half the interval"
 * means for the catch-up rule. Never below the floor for a validated recurrence. */
export function intervalAfter(
	recurrence: Recurrence,
	timezone: string,
	occurrence: Date,
	anchorAt: Date
): number {
	const next = nextOccurrence(recurrence, timezone, occurrence, anchorAt);
	return next ? next.getTime() - occurrence.getTime() : MIN_INTERVAL_MS;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A plain-language line for a recurrence, for lists and the editor. */
export function describeRecurrence(recurrence: Recurrence): string {
	switch (recurrence.type) {
		case "hours":
			return recurrence.every === 1 ? "Every hour" : `Every ${recurrence.every} hours`;
		case "daily":
			return `Every day at ${recurrence.at}`;
		case "weekdays":
			return `Weekdays at ${recurrence.at}`;
		case "weekly":
			return `Every ${DAYS[recurrence.day]} at ${recurrence.at}`;
		case "cron":
			return `Cron ${recurrence.expr}`;
	}
}
