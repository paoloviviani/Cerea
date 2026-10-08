import type { RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { error } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireJsonBody, requireSchedules } from "$lib/server/schedules/api";
import {
	describeRecurrence,
	isValidTimezone,
	nextOccurrences,
	validateRecurrence,
} from "$lib/server/schedules/recurrence";

const bodySchema = z.object({ recurrence: z.unknown(), timezone: z.string().max(64) });

/**
 * The editor's preview: the next three run times of a recurrence in a zone, or
 * the reason it is refused (the 15-minute floor included). Nothing is stored.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireSchedules(locals);
	requireJsonBody(request);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { recurrence, timezone }.");
	const { recurrence, timezone } = parsed.data;
	if (!isValidTimezone(timezone))
		return superjsonResponse({ ok: false, error: "That is not a known timezone." });
	const now = new Date();
	const checked = validateRecurrence(recurrence, timezone, now);
	if (!checked.ok) return superjsonResponse({ ok: false, error: checked.error });
	return superjsonResponse({
		ok: true,
		description: describeRecurrence(checked.recurrence),
		next: nextOccurrences(checked.recurrence, timezone, now, now, 3),
	});
};
