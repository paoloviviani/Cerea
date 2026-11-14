/**
 * Whose notes an agent screen shows. Session notes belong to the root of a session tree (a subagent
 * or delegate child works for the session that started it, and Cerea keys the notes by the root), so
 * a child session's Notes view is its root's.
 */
export function notesSessionId(
	agent: { rootId?: string } | null | undefined,
	agentId: string
): string {
	return agent?.rootId || agentId;
}
