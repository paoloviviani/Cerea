import { browser } from "$app/environment";
import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
import { listAgents, listWorkspaces } from "$lib/codeApi";
import { reconcileById } from "$lib/utils/reconcileById";
import { clearCodeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeEnrollment } from "$lib/stores/codeEnrollment.svelte";
import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
import { onCodeReauth } from "$lib/stores/codeReauth.svelte";

/** One paired device's live subtree, read through the proxy. */
export interface DeviceSubtree {
	workspaces: CodeWorkspace[];
	agents: CodeAgentSession[];
	/** The last read of the daemon behind this pairing failed. Any rows are
	 * the last good ones, kept rather than blanked. */
	off: boolean;
}

/**
 * How long a list read is trusted when the panel is entered again: the poll
 * interval, so a returning visit never shows a status older than one poll
 * would have. The cached rows still draw at once and the re-read folds in
 * place, so a read on most visits does not flash.
 */
export const CODE_CACHE_STALE_MS = 8_000;

/**
 * The machines' workspaces and sessions, kept for the browser session
 * (stale-while-revalidate): the sidebar tree mounts and unmounts as the
 * person moves between chats and `/code`, and its rows used to be component
 * state, so every visit began empty and filled in again. Memory only, per
 * person: signing out, a different account, and a stale sign-in all drop it.
 */
export const codeTreeCache = $state<{
	trees: Record<string, DeviceSubtree>;
	fetchedAt: Record<string, number>;
	owner: string | null;
}>({ trees: {}, fetchedAt: {}, owner: null });

const seqs = new Map<string, number>();
/** Bumped by every clear and every dropped tree: a read that began before one
 * (even a device's first, which has no `seqs` entry yet) must not land. */
let generation = 0;

export function isCodeTreeFresh(deviceId: string, now = Date.now()): boolean {
	const at = codeTreeCache.fetchedAt[deviceId];
	return at !== undefined && now - at < CODE_CACHE_STALE_MS;
}

/**
 * Read one device's subtree and fold it into the cache in place: unchanged
 * rows keep their objects. A failed read keeps the rows it has and flags
 * `off`; with nothing cached it records an empty, `off` tree as before.
 * A read that started before a newer one for the same device is discarded.
 */
export async function loadDeviceTree(deviceId: string): Promise<void> {
	const seq = (seqs.get(deviceId) ?? 0) + 1;
	seqs.set(deviceId, seq);
	const gen = generation;
	let fresh: { workspaces: CodeWorkspace[]; agents: CodeAgentSession[] } | null = null;
	try {
		const [{ workspaces }, { agents }] = await Promise.all([
			listWorkspaces(deviceId),
			listAgents(deviceId),
		]);
		fresh = { workspaces, agents };
	} catch {
		fresh = null;
	}
	if (gen !== generation || seqs.get(deviceId) !== seq) return;
	const prev = codeTreeCache.trees[deviceId];
	if (!fresh) {
		if (!prev) codeTreeCache.trees[deviceId] = { workspaces: [], agents: [], off: true };
		else if (!prev.off) prev.off = true;
		return;
	}
	codeTreeCache.fetchedAt[deviceId] = Date.now();
	if (!prev) {
		codeTreeCache.trees[deviceId] = { ...fresh, off: false };
		return;
	}
	const workspaces = reconcileById(prev.workspaces, fresh.workspaces);
	const agents = reconcileById(prev.agents, fresh.agents);
	if (workspaces !== prev.workspaces) prev.workspaces = workspaces;
	if (agents !== prev.agents) prev.agents = agents;
	if (prev.off) prev.off = false;
}

/** A session was archived or deleted here and the daemon said yes: its row
 * goes now; the re-read that follows confirms it. */
export function dropCachedAgent(deviceId: string, agentId: string): void {
	const tree = codeTreeCache.trees[deviceId];
	if (tree) tree.agents = tree.agents.filter((a) => a.id !== agentId);
}

/** A machine was removed. */
export function dropCachedTree(deviceId: string): void {
	generation += 1;
	delete codeTreeCache.trees[deviceId];
	delete codeTreeCache.fetchedAt[deviceId];
}

function clearTrees(): void {
	generation += 1;
	codeTreeCache.trees = {};
	codeTreeCache.fetchedAt = {};
}

/** Sign-out: forget every machine, workspace and session this tab learned. */
export function clearCodePanelCache(): void {
	clearTrees();
	clearCodeDeviceList();
	for (const id of Object.keys(codeEnrollment)) delete codeEnrollment[id];
	for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
	codeTreeCache.owner = null;
}

/** Tell the cache whose it is. A different person than the one it was filled
 * for empties it before anything can draw from it. */
export function bindCodeCacheOwner(userId: string | null | undefined): void {
	// Never on the server: this module is shared by every request there.
	if (!browser || !userId) return;
	if (codeTreeCache.owner && codeTreeCache.owner !== userId) clearCodePanelCache();
	codeTreeCache.owner = userId;
}

// A stale sign-in drops the subtrees with the device list.
onCodeReauth(clearTrees);
