/**
 * The deployment's levers on scheduled actions, read at call time.
 *
 * `CHAT_SCHEDULES_ENABLED` is the **kill switch**. Its default is ON, and
 * exactly `"false"` turns it off — the shape of `CODE_FILES_ENABLED`, not of
 * `CODE_TERMINAL_ENABLED`. Why on: the only kind that exists runs on the
 * /code panel's machine link, which is itself off unless the operator set
 * `CODE_AGENTS_ENABLED=true`; each schedule is something a person built,
 * capped per user, no faster than every 15 minutes, and its permission mode
 * defaults to Ask, which stalls rather than acts. So there is no new power
 * to opt into that the operator has not already opted into; what an operator
 * needs is a way to stop it fast, and a switch whose default is off cannot be
 * that. Off: nothing fires (due rows wait, and come back as `missed-downtime`
 * if the downtime was long, like any other), the API answers 404 and the
 * panel hides the entry. Rows are never deleted by the switch.
 *
 * `CHAT_SCHEDULES_MAX_PER_USER`: schedules one person may have (default 20).
 */

import { config } from "$lib/server/config";

export const DEFAULT_MAX_SCHEDULES_PER_USER = 20;

export function schedulesEnabled(): boolean {
	return config.CHAT_SCHEDULES_ENABLED !== "false";
}

export function maxSchedulesPerUser(): number {
	const raw = (config.CHAT_SCHEDULES_MAX_PER_USER ?? "").trim();
	const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
	return parsed > 0 ? parsed : DEFAULT_MAX_SCHEDULES_PER_USER;
}
