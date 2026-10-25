import { z } from "zod";
import { dev } from "$app/environment";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { parseLocale } from "$lib/i18n/resolve";

/**
 * The `locale` field of the settings schema, shared by both settings
 * endpoints (the client store saves through `/settings`, the v2 API carries
 * the same field). Same contract as the palette fields: a null (the gateway's
 * and superjson's form of "unset") or an unknown value is ignored rather than
 * failing the whole save, so a newer or older client posting a locale this
 * build does not carry cannot lose the rest of the person's settings.
 */
export const localeFields = {
	locale: z.string().nullish().catch(undefined),
};

/** Whether the pseudo-locale (`en-XA`) may be chosen: development, or CHAT_PSEUDO_LOCALE=true. */
export function pseudoLocaleEnabled(): boolean {
	return dev || config.CHAT_PSEUDO_LOCALE === "true";
}

/**
 * What to `$set` for the locale: only a value that names a locale this
 * deployment may serve. Anything else leaves the stored choice alone (Mongo
 * would store `undefined` as null and wipe it).
 */
export function localePatch(
	{ locale }: { locale?: string | null },
	pseudo: boolean = pseudoLocaleEnabled()
) {
	const parsed = parseLocale(locale, pseudo);
	return parsed ? { locale: parsed } : {};
}

/**
 * The person's (or session's) saved language. A failure here must never fail
 * the page, so it degrades to "no saved choice".
 */
export async function savedLocaleFor(locals: App.Locals): Promise<string | undefined> {
	try {
		const settings = await collections.settings.findOne(authCondition(locals), {
			projection: { locale: 1 },
		});
		return typeof settings?.locale === "string" ? settings.locale : undefined;
	} catch (err) {
		logger.debug({ err }, "locale lookup failed; resolving without a saved choice");
		return undefined;
	}
}
