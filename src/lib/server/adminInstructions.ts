import { config } from "$lib/server/config";

/** The longest the administrator's instructions may be, in characters. */
export const ADMIN_INSTRUCTIONS_MAX = 4000;

/**
 * The administrator's instructions: one text for every chat on this
 * deployment, written under Administration -> Assistant instructions.
 *
 * Stored in the chat's own `config` collection like the other admin switches,
 * so it is read from `config`'s in-memory copy (refreshed when another process
 * saves): a turn adds no database round trip. Empty means none. Deployment
 * configuration, not personal data: nothing here is erased with an account.
 *
 * Chat turns only. The /code panel, galopin and title generation never call it.
 */
export function adminInstructions(): string {
	return (config.ADMIN_INSTRUCTIONS ?? "").trim().slice(0, ADMIN_INSTRUCTIONS_MAX);
}

/** Whether users may read the instructions in Settings. On unless explicitly `"false"`. */
export function adminInstructionsVisible(): boolean {
	return config.ADMIN_INSTRUCTIONS_VISIBLE !== "false";
}

/**
 * What a non-admin's settings carry: the text only while it is visible and
 * set, and otherwise nothing at all, not even an empty field, so a hidden
 * prompt cannot be told from none.
 */
export function visibleAdminInstructions(): { adminInstructions?: string } {
	const text = adminInstructions();
	return text && adminInstructionsVisible() ? { adminInstructions: text } : {};
}

/** A system prompt with the administrator's instructions first, when there are any. */
export function withAdminInstructions(prompt: string): string {
	const text = adminInstructions();
	return text ? `${text}\n\n${prompt}` : prompt;
}
