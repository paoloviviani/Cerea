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
