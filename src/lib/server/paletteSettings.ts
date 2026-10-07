import { z } from "zod";
import { ACCENTS, NEUTRALS, paletteAttributes } from "$lib/utils/palettes";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { logger } from "$lib/server/logger";

/**
 * The palette fields of the settings schema, shared by both settings
 * endpoints (the client store saves through `/settings`, the v2 API carries
 * the same fields). An unknown value is *ignored* rather than rejected —
 * `.catch(undefined)` — so a stale or newer client posting a palette this
 * build does not know does not fail the whole settings save.
 */
export const paletteFields = {
	accent: z.enum(ACCENTS).optional().catch(undefined),
	neutral: z.enum(NEUTRALS).optional().catch(undefined),
};

/**
 * What to `$set` for the palette: only the fields that were actually sent and
 * valid. Mongo would store an `undefined` as null and wipe a saved choice, so
 * an older client that omits the fields must leave them alone.
 */
export function palettePatch({
	accent,
	neutral,
}: {
	accent?: z.infer<typeof paletteFields.accent>;
	neutral?: z.infer<typeof paletteFields.neutral>;
}) {
	return { ...(accent && { accent }), ...(neutral && { neutral }) };
}

/**
 * The `<html>` attributes for this request's person, for the first paint. A
 * failure here must never fail the page, so it degrades to the defaults.
 */
export async function paletteAttributesFor(locals: App.Locals): Promise<string> {
	try {
		const settings = await collections.settings.findOne(authCondition(locals), {
			projection: { accent: 1, neutral: 1 },
		});
		return paletteAttributes(settings ?? {});
	} catch (err) {
		logger.debug({ err }, "palette lookup failed; rendering the default palette");
		return "";
	}
}
