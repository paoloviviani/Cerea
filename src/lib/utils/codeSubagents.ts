/**
 * How the /code sidebar marks subagents, without a tree: a parent and its
 * subagent can live in different workspaces (worktrees), so each session
 * stays under its own workspace, and the relation is stated on the rows.
 *
 * - A subagent row: a "sub" badge, "↳ from ‹parent›" (plus "· ‹workspace›"
 *   when the parent lives in another one), and its status, with waiting for
 *   approval as the loud one.
 * - A parent row: "N subagents", linking to each, and a flag when any
 *   descendant waits for approval.
 *
 * A spawned session (`session_spawn`) is a peer, not a subagent: it has no
 * parent edge, so it is always listed, and it is marked with a "spawned by"
 * chip (a different glyph from "↳ from", which stays for real parentage) and
 * sorted right after its spawner. The spawner carries an informational
 * "spawned N" count.
 */
import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";

export type SubagentStatus = "waiting" | "running" | "failed" | "done";

export interface SubagentRow {
	parentId: string;
	/** The parent's title, or null when the parent is not in the list. */
	parentTitle: string | null;
	parentWorkspaceId: string | null;
	/** Set when the parent lives in a different workspace than this row. */
	elsewhere: string | null;
	status: SubagentStatus;
}

/** A spawned session (`session_spawn`): a top-level row, not a subagent —
 * it has no parent edge — that still says who created it, as a provenance
 * chip. */
export interface SpawnedRow {
	sessionId: string;
	/** The spawner's title when the session was created; the live title when
	 * the spawner is still listed. */
	title: string;
	/** Where the spawner lives, when it is in the list: the link's target. */
	workspaceId: string | null;
	elsewhere: string | null;
	/** The spawner is no longer listed (archived or deleted): the title is the
	 * one recorded at creation, and there is nothing to link to. */
	gone: boolean;
}

export function spawnedRow(
	agent: CodeAgentSession,
	agents: CodeAgentSession[],
	workspaces: CodeWorkspace[]
): SpawnedRow | null {
	const marker = agent.spawnedBy;
	if (!marker || agent.parentId) return null;
	const spawner = agents.find((a) => a.id === marker.sessionId);
	const spawnerWorkspace = spawner
		? workspaces.find((w) => w.id === spawner.workspaceId)
		: undefined;
	return {
		sessionId: marker.sessionId,
		title: spawner?.title ?? marker.title,
		workspaceId: spawner?.workspaceId ?? null,
		elsewhere:
			spawner && spawner.workspaceId !== agent.workspaceId
				? (spawnerWorkspace?.name ?? null)
				: null,
		gone: !spawner,
	};
}

export interface SpawnerRow {
	count: number;
	children: Array<{ id: string; title: string; workspaceId: string; workspaceName: string | null }>;
}

/** The spawner's side: the sessions it spawned that are still listed. */
export function spawnerRow(
	agent: CodeAgentSession,
	agents: CodeAgentSession[],
	workspaces: CodeWorkspace[]
): SpawnerRow | null {
	const children = agents
		.filter((a) => !a.parentId && a.spawnedBy?.sessionId === agent.id)
		.map((a) => ({
			id: a.id,
			title: a.title,
			workspaceId: a.workspaceId,
			workspaceName: workspaces.find((w) => w.id === a.workspaceId)?.name ?? null,
		}));
	return children.length ? { count: children.length, children } : null;
}

/** Longest spawn chain grouped under its first spawner. */
const MAX_SPAWN_DEPTH = 2;

/**
 * Adjacency, not containment: each spawned session is sorted right after its
 * spawner (recursing along the chain, up to two deep), at the same indent.
 * `agents` is one workspace's list; a spawner that is absent from it (gone, or
 * in another workspace) leaves the session where the list already puts it.
 */
export function groupSpawned(agents: CodeAgentSession[]): CodeAgentSession[] {
	const byId = new Map(agents.map((a) => [a.id, a]));
	const spawnerOf = (a: CodeAgentSession) =>
		!a.parentId && a.spawnedBy ? byId.get(a.spawnedBy.sessionId) : undefined;
	const depth = (a: CodeAgentSession): number => {
		const seen = new Set([a.id]);
		let d = 0;
		for (let cur = spawnerOf(a); cur; cur = spawnerOf(cur)) {
			if (seen.has(cur.id)) return Infinity; // a cycle groups nowhere
			seen.add(cur.id);
			d++;
		}
		return d;
	};
	const followers = new Map<string, CodeAgentSession[]>();
	const heads: CodeAgentSession[] = [];
	for (const a of agents) {
		const spawner = spawnerOf(a);
		const d = depth(a);
		if (spawner && d >= 1 && d <= MAX_SPAWN_DEPTH) {
			followers.set(spawner.id, [...(followers.get(spawner.id) ?? []), a]);
		} else heads.push(a);
	}
	const out: CodeAgentSession[] = [];
	const emit = (a: CodeAgentSession) => {
		out.push(a);
		for (const f of followers.get(a.id) ?? []) emit(f);
	};
	heads.forEach(emit);
	return out;
}

export interface ParentRow {
	count: number;
	waiting: boolean;
	children: Array<{ id: string; title: string; workspaceId: string; workspaceName: string | null }>;
}

export function subagentStatus(agent: CodeAgentSession): SubagentStatus {
	switch (agent.state) {
		case "waiting-permission":
			return "waiting";
		case "running":
			return "running";
		case "error":
			return "failed";
		default:
			return "done";
	}
}

export function subagentRow(
	agent: CodeAgentSession,
	agents: CodeAgentSession[],
	workspaces: CodeWorkspace[]
): SubagentRow | null {
	if (!agent.parentId) return null;
	const parent = agents.find((a) => a.id === agent.parentId);
	const parentWorkspace = parent ? workspaces.find((w) => w.id === parent.workspaceId) : undefined;
	return {
		parentId: agent.parentId,
		parentTitle: parent?.title ?? null,
		parentWorkspaceId: parent?.workspaceId ?? null,
		elsewhere:
			parent && parent.workspaceId !== agent.workspaceId ? (parentWorkspace?.name ?? null) : null,
		status: subagentStatus(agent),
	};
}

export function parentRow(
	agent: CodeAgentSession,
	agents: CodeAgentSession[],
	workspaces: CodeWorkspace[]
): ParentRow | null {
	const listed = agents.filter((a) => a.parentId === agent.id);
	const count = Math.max(agent.childSummary?.children ?? 0, listed.length);
	if (count === 0) return null;
	// The machine's summary counts waiting descendants at any depth, across
	// workspaces; the listed children cover a machine that predates it.
	const waiting =
		(agent.childSummary?.waiting ?? 0) > 0 ||
		listed.some((child) => child.state === "waiting-permission");
	return {
		count,
		waiting,
		children: listed.map((child) => ({
			id: child.id,
			title: child.title,
			workspaceId: child.workspaceId,
			workspaceName: workspaces.find((w) => w.id === child.workspaceId)?.name ?? null,
		})),
	};
}

/** The sidebar's filter: subagents shown (the default) or hidden. */
export function visibleAgents(agents: CodeAgentSession[], showSubagents: boolean) {
	return showSubagents ? agents : agents.filter((agent) => !agent.parentId);
}

export const SHOW_SUBAGENTS_KEY = "code.showSubagents";

export function readShowSubagents(storage: Pick<Storage, "getItem"> | undefined): boolean {
	return storage?.getItem(SHOW_SUBAGENTS_KEY) !== "false";
}
