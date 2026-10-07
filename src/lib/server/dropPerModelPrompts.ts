import type { Collection } from "mongodb";
import type { Settings } from "$lib/types/Settings";

/**
 * Per-model system prompts were removed (they live on as custom models, which
 * nobody's old prompts were migrated to: the decision was to drop them). The
 * settings API no longer reads or writes the two fields, so nothing applies
 * them; this removes what is still stored so it does not sit in the database
 * for ever.
 *
 * Idempotent, and run at boot from `Database.initDatabase` rather than as a
 * `Migration` routine: the routine list is empty and routines run in a
 * transaction. A document without the fields does not match, so a second run
 * touches nothing.
 */
export async function dropPerModelPrompts(settings: Collection<Settings>): Promise<number> {
	const { modifiedCount } = await settings.updateMany(
		{ $or: [{ customPrompts: { $exists: true } }, { customPromptsEnabled: { $exists: true } }] },
		{ $unset: { customPrompts: "", customPromptsEnabled: "" } } as never
	);
	return modifiedCount;
}
