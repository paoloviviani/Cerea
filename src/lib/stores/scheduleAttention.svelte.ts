import { listSchedules } from "$lib/codeApi";
import type { ScheduleView } from "$lib/types/Schedule";
import { scheduleNeedsAttention } from "$lib/utils/scheduleFormat";

/**
 * How many schedules need the user's attention, for the badge on the sidebar's
 * Schedules row (and nothing else: no count of schedules, no "all fine" mark).
 * A schedule needs attention when its last run failed, when it was switched off
 * with a reason (three failures in a row, a lost grant), or when it is on but
 * cannot run for lack of access.
 *
 * The sidebar is mounted twice (rail and drawer), so this is a module with a
 * ref-counted poll, like `codeDeviceList`: one request every minute while any
 * sidebar is mounted, and the Schedules page feeds it whenever it reads the
 * list, so the badge clears as soon as the problem does.
 */
export const scheduleAttention = $state({ count: 0 });

const POLL_MS = 60_000;
let refCount = 0;
let handle: ReturnType<typeof setInterval> | null = null;

export function setScheduleAttention(schedules: ScheduleView[]): void {
	scheduleAttention.count = schedules.filter(scheduleNeedsAttention).length;
}

async function refresh(): Promise<void> {
	try {
		setScheduleAttention((await listSchedules()).schedules);
	} catch {
		// A failed read leaves the last answer; the next tick tries again.
	}
}

/** Call from an effect while the sidebar shows the row; call the result on cleanup. */
export function watchScheduleAttention(): () => void {
	if (refCount++ === 0) {
		void refresh();
		handle = setInterval(() => void refresh(), POLL_MS);
	}
	return () => {
		if (--refCount === 0 && handle) {
			clearInterval(handle);
			handle = null;
		}
	};
}
