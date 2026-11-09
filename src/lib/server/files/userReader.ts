import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";

/**
 * The document reader this user chose for their chat uploads, or undefined for
 * the deployment's default. Past chats are text and never extracted, so they
 * have no reader of their own.
 */
export async function userDocumentReader(locals: App.Locals): Promise<string | undefined> {
	if (!locals.user && !locals.sessionId) return undefined;
	const settings = await collections.settings.findOne(authCondition(locals), {
		projection: { documentReader: 1 },
	});
	return settings?.documentReader?.trim() || undefined;
}
