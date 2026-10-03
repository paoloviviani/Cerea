/**
 * Whether the approval card may offer "Always allow (this session)" for a
 * tool: not when the machine's ceiling holds that key below allow. There the
 * machine answers once and stores no exception, so the button would promise
 * what the next call contradicts.
 *
 * A context rather than a prop because the card sits three components below
 * the surface that knows the ceiling (the agent view, the inbox's item). A
 * card with no provider above it (chat) offers what it always did.
 */
export const ALWAYS_CAPPED = Symbol("code.alwaysCapped");

/** `true` for a tool whose "always" would store nothing. */
export type AlwaysCapped = (tool: string) => boolean;
