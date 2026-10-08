/**
 * The one line a scheduled agent run puts before the person's prompt, so the
 * session knows it runs unattended, on a timetable, and what it was granted:
 *
 *   [Scheduled run of "Nightly", Every day at 02:00 (Europe/Rome); previous run 3 h ago; coordination: session_list, session_read]
 *
 * Pure: the executor passes in what it knows. The name is the person's text, so
 * it is flattened to one line, capped and stripped of quotes and brackets: no
 * name can close the bracket or start a line of its own.
 */
import { recurrenceText } from "$lib/utils/scheduleFormat";
import type { Recurrence } from "$lib/types/Schedule";

const NAME_MAX = 80;

export function headerName(name: string): string {
	const flat = name
		.replace(/[[\]"\\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1).trimEnd()}…` : flat;
}

/** "3 h ago", "2 days ago", "just now", or "none". */
export function relativeAgo(then: Date | null | undefined, now: Date): string {
	if (!then) return "none";
	const minutes = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} days ago`;
}

export function scheduledRunHeader(input: {
	name: string;
	recurrence: Recurrence;
	timezone: string;
	previousRunAt: Date | null | undefined;
	now: Date;
	/** "session_list, session_read", or "none" / "none (reason)". */
	coordination: string;
}): string {
	return (
		`[Scheduled run of "${headerName(input.name)}", ${recurrenceText(input.recurrence)} ` +
		`(${headerName(input.timezone)}); previous run ${relativeAgo(input.previousRunAt, input.now)}; ` +
		`coordination: ${input.coordination}]`
	);
}
