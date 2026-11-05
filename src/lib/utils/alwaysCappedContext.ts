/**
 * Whether the machine's ceiling holds a tool's key below allow. The approval
 * card no longer hides "Always allow (this session)" for it (a human's
 * "always" is stored over an ask limit; only the loop brake stays once-only);
 * it uses this to know that such a key asks every turn, so the first-turn
 * chip is not drawn.
 *
 * A context rather than a prop because the card sits three components below
 * the surface that knows the ceiling (the agent view, the inbox's item). A
 * card with no provider above it (chat) offers what it always did.
 */
export const ALWAYS_CAPPED = Symbol("code.alwaysCapped");

/** `true` for a tool whose "always" would store nothing. */
export type AlwaysCapped = (tool: string) => boolean;
