import type { AgentUsageUpdate } from "$lib/types/CodeAgent";

type Usage = AgentUsageUpdate["usage"];

/**
 * The usage the context meter should show after `next` arrives. A frame with no
 * positive `used` is a message that has not reported yet (opencode creates each
 * assistant message with zero tokens and fills them in when its step ends), not
 * an empty context, so it keeps the last reported value instead of dropping the
 * meter to 0% for the whole of a turn.
 */
export function keepReportedUsage(previous: Usage | null, next: Usage): Usage | null {
	return (next.used ?? 0) > 0 ? next : previous;
}
