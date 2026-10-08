import type { PillTone } from "$lib/components/overlay/styles";
import type { Recurrence, ScheduleRunStatus } from "$lib/types/Schedule";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A moment in the person's own zone: "Mon 12 Oct, 09:00". */
export function formatWhen(at: Date | string | null | undefined, timeZone?: string): string {
	if (!at) return "—";
	const date = typeof at === "string" ? new Date(at) : at;
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		...(timeZone ? { timeZone } : {}),
	}).format(date);
}

/** The same with the year, for a history that goes back months. */
export function formatWhenLong(at: Date | string, timeZone?: string): string {
	const date = typeof at === "string" ? new Date(at) : at;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		...(timeZone ? { timeZone } : {}),
	}).format(date);
}

export const RUN_STATUS_LABEL: Record<ScheduleRunStatus, string> = {
	sent: "Sent",
	"skipped-still-running": "Skipped: still running",
	"missed-offline": "Missed: machine offline",
	"missed-downtime": "Missed: Cerea was down",
	failed: "Failed",
};

export const RUN_STATUS_TONE: Record<ScheduleRunStatus, PillTone> = {
	sent: "good",
	"skipped-still-running": "neutral",
	"missed-offline": "neutral",
	"missed-downtime": "neutral",
	failed: "bad",
};

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
		const supported = (
			Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
		).supportedValuesOf?.("timeZone");
		if (supported?.length) return ["UTC", ...supported.filter((z) => z !== "UTC")];
	} catch {
		/* an older engine: the datalist is a nicety */
	}
	return ["UTC"];
}
