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
	// A saved value wins even when empty (clearing sticks); the environment is
	// only the default for a deployment that never saved one.
	const raw = config.getSaved("ADMIN_INSTRUCTIONS") ?? config.ADMIN_INSTRUCTIONS ?? "";
	return raw.trim().slice(0, ADMIN_INSTRUCTIONS_MAX);
}

/** Whether users may read the instructions in Settings. On unless explicitly `"false"`. */
export function adminInstructionsVisible(): boolean {
	const raw = config.getSaved("ADMIN_INSTRUCTIONS_VISIBLE") ?? config.ADMIN_INSTRUCTIONS_VISIBLE;
	return raw !== "false";
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

/** The line that opens the block, and the one that closes it. Fixed text: the prefix stays cacheable. */
export const ADMIN_INSTRUCTIONS_OPEN = "Instructions from this deployment's administrator:";
export const ADMIN_INSTRUCTIONS_CLOSE = "End of the administrator's instructions.";

/**
 * The administrator's instructions as a delimited block, or "" when there are
 * none. Labelled and closed so that whatever a user wrote after it cannot read
 * as a continuation of it (or the other way round).
 */
export function adminInstructionsBlock(): string {
	const text = adminInstructions();
	return text ? `${ADMIN_INSTRUCTIONS_OPEN}\n${text}\n${ADMIN_INSTRUCTIONS_CLOSE}` : "";
}

/** A system prompt with the administrator's block first, when there are instructions. */
export function withAdminInstructions(prompt: string): string {
	const block = adminInstructionsBlock();
	if (!block) return prompt;
	return prompt ? `${block}\n\n${prompt}` : block;
}
