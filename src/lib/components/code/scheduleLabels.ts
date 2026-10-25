/**
 * The words for a schedule's recurrence, a run's status and the weekdays,
 * for the Code panel. `utils/scheduleFormat.ts` keeps its English
 * `recurrenceText` for the server (the run header the agent reads); these are
 * the screen's, through the catalogue.
 */
import { m } from "$lib/paraglide/messages";
import type { Recurrence, ScheduleRunStatus } from "$lib/types/Schedule";

const RUN_STATUS: Record<ScheduleRunStatus, () => string> = {
	sent: m["code.schedule.status.sent"],
	"skipped-still-running": m["code.schedule.status.skipped_still_running"],
	"missed-offline": m["code.schedule.status.missed_offline"],
	"missed-downtime": m["code.schedule.status.missed_downtime"],
	failed: m["code.schedule.status.failed"],
};

export function runStatusLabel(status: ScheduleRunStatus): string {
	return RUN_STATUS[status]();
}

const WEEKDAYS: Array<() => string> = [
	m["code.schedule.weekday.sunday"],
	m["code.schedule.weekday.monday"],
	m["code.schedule.weekday.tuesday"],
	m["code.schedule.weekday.wednesday"],
	m["code.schedule.weekday.thursday"],
	m["code.schedule.weekday.friday"],
	m["code.schedule.weekday.saturday"],
];

/** Day names, Sunday first (the index `Recurrence.day` uses). */
export function weekdayNames(): string[] {
	return WEEKDAYS.map((name) => name());
}

export function recurrenceLabel(recurrence: Recurrence): string {
	switch (recurrence.type) {
		case "hours":
			return recurrence.every === 1
				? m["code.schedule.recurrence.hour"]()
				: m["code.schedule.recurrence.hours"]({ every: recurrence.every });
		case "daily":
			return m["code.schedule.recurrence.daily"]({ at: recurrence.at });
		case "weekdays":
			return m["code.schedule.recurrence.weekdays"]({ at: recurrence.at });
		case "weekly":
			return m["code.schedule.recurrence.weekly"]({
				day: WEEKDAYS[recurrence.day]?.() ?? "",
				at: recurrence.at,
			});
		case "cron":
			return m["code.schedule.recurrence.cron"]({ expr: recurrence.expr });
	}
}
