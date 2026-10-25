import { formatDate } from "$lib/i18n/format";
import type { PillTone } from "$lib/components/overlay/styles";
import type { Recurrence, ScheduleRunStatus } from "$lib/types/Schedule";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A moment in the person's own zone: "Mon 12 Oct, 09:00". */
export function formatWhen(at: Date | string | null | undefined, timeZone?: string): string {
	if (!at) return "—";
	return formatDate(at, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		...(timeZone ? { timeZone } : {}),
	});
}

/** The same with the year, for a history that goes back months. */
export function formatWhenLong(at: Date | string, timeZone?: string): string {
	return formatDate(at, {
		year: "numeric",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		...(timeZone ? { timeZone } : {}),
	});
}

export const RUN_STATUS_TONE: Record<ScheduleRunStatus, PillTone> = {
	sent: "good",
	"skipped-still-running": "neutral",
	"missed-offline": "neutral",
	"missed-downtime": "neutral",
	failed: "bad",
};

/**
 * The recurrence in English, for text the server writes (the run header the
 * agent reads). The screens use `recurrenceLabel` in
 * `components/code/scheduleLabels.ts`, through the catalogue.
 */
// i18n: server text
export function recurrenceText(recurrence: Recurrence): string {
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

export const WEEKDAY_NAMES = DAYS;

/** The browser's own zone, the default for a new schedule. */
export function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export function allTimezones(): string[] {
	try {
		const supported = Intl.supportedValuesOf?.("timeZone");
		if (supported?.length) return ["UTC", ...supported.filter((z) => z !== "UTC")];
	} catch {
		/* an older engine: the datalist is a nicety */
	}
	return ["UTC"];
}
