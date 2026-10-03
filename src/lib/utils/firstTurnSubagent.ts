/**
 * "New subagent · first turn asks": opencode starts a subagent before Cerea
 * can hand it the session's setting, so a subagent's FIRST turn asks whatever
 * the main session's selector says (Allow included). The card names that, so
 * the ask does not read as the setting being ignored.
 *
 * Recognised from what the panel already has, never from a marker on the ask:
 * the ask comes from a subagent (a child session id that is not the root's) and
 * that subagent has not yet had a second turn. Its transcript says so: a child
 * starts with exactly one user message (the prompt its parent gave it), and a
 * later turn is a later user message. A transcript that cannot be read draws no
 * chip: an unknown is never claimed as a first turn.
 */
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";

export const FIRST_TURN_SUBAGENT = Symbol("code.firstTurnSubagent");

/** What the approval card asks, per subagent ask. */
export interface FirstTurnSubagent {
	/** The subagent that is asking, when the card cannot read that off the ask
	 * itself (the inbox's cards carry no child id). */
	childId?: string;
	/** The ROOT session's permission mode, when the surface showing the card
	 * knows it. The chip draws only on "allow": under Ask everything asks
	 * anyway, so the chip would be noise. Absent means unknown, and unknown
	 * draws nothing. */
	rootMode?: string | null;
	/** Start reading the child's transcript for this ask, once. */
	ensure(childId: string, askId: string): void;
	/** Whether that ask is known to be from the subagent's first turn. */
	isFirst(childId: string, askId: string): boolean;
}

export const FIRST_TURN_LABEL = "New subagent · first turn asks";
export const FIRST_TURN_HINT =
	"opencode starts a subagent before Cerea can hand it your permission setting, so a new subagent's first turn asks you whatever the setting is.";

/** How many user messages a transcript holds: a child starts with one. */
export function userTurns(updates: AgentStreamUpdate[]): number {
	return updates.filter((update) => update.type === "user").length;
}

/** A transcript with at most the starting prompt: the subagent has not yet had
 * a second turn. */
export function isFirstTurn(updates: AgentStreamUpdate[]): boolean {
	return userTurns(updates) <= 1;
}

/**
 * Permission keys that ask under every setting, Allow included — so a chip
 * saying "first turn asks" would wrongly suggest the ask stops afterwards:
 * writing outside the project folder, the stuck-agent brake, reading `.env`,
 * and the read-only tools that never reach a card through the blanket
 * (they ask, if at all, by their own rule).
 */
export const ALWAYS_ASKS_KEYS = new Set([
	"read",
	"glob",
	"grep",
	"list",
	"lsp",
	"question",
	"todowrite",
	"todoread",
	"plan_enter",
	"plan_exit",
	"skill",
	"external_directory",
	"doom_loop",
]);
