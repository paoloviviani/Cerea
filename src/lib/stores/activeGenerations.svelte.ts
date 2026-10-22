/**
 * Which conversations have a generation running right now — plus turns parked
 * on a timer or a question — kept separate from the
 * sidebar store on purpose: that store does a last-write-wins full replace on every
 * conversation invalidation, which would wipe a generating flag stored on the row.
 * Holding this state alongside it — not on it — sidesteps that entirely.
 *
 * SSR-safe like conversations.svelte.ts: a factory plus context helpers, no
 * module-level mutable state. Populated only in the browser by the live watcher.
 */

import { getContext, setContext } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { ObjectId } from "mongodb";

export const ACTIVE_GENERATIONS_CONTEXT_KEY = "activeGenerationsStore";

/**
 * Statuses the live feed reports from the turn-state docs (see
 * $lib/types/TurnState): the two parked states, plus recent failures so the
 * sidebar can flag a run that died while nobody was looking.
 */
export type ParkedTurnStatus = "waiting" | "awaiting_input" | "failed";

export interface ParkedTurn {
	status: ParkedTurnStatus;
	/** Epoch ms after which the flag stops being shown. Failed turns only. */
	expiresAt?: number;
}

class ActiveGenerationsStore {
	#ids = new SvelteSet<string>();
	#parked = new SvelteMap<string, ParkedTurn>();

	has(conversationId: string | ObjectId): boolean {
		return this.#ids.has(String(conversationId));
	}

	/** Replace the running set with the latest snapshot from the server. */
	setRunning(conversationIds: string[]): void {
		const next = new Set(conversationIds.map(String));
		if (next.size === this.#ids.size && [...next].every((id) => this.#ids.has(id))) return;
		this.#ids.clear();
		for (const id of next) this.#ids.add(id);
	}

	/** Replace the parked set with the latest snapshot from the server. */
	setParked(entries: Array<{ conversationId: string } & ParkedTurn>): void {
		const next = new Map<string, ParkedTurn>(
			entries.map((entry) => [
				String(entry.conversationId),
				{
					status: entry.status,
					...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
				},
			])
		);
		if (
			next.size === this.#parked.size &&
			[...next].every(([id, turn]) => {
				const seen = this.#parked.get(id);
				return seen?.status === turn.status && seen?.expiresAt === turn.expiresAt;
			})
		) {
			return;
		}
		this.#parked.clear();
		for (const [id, turn] of next) this.#parked.set(id, turn);
	}

	/**
	 * Drops flags whose display window has passed. The live feed closes once
	 * only failed turns remain (they are terminal, nothing will change), so
	 * without this sweep a long-lived tab would show a failed badge forever.
	 */
	pruneExpired(now = Date.now()): void {
		for (const [id, turn] of this.#parked) {
			if (turn.expiresAt !== undefined && turn.expiresAt <= now) this.#parked.delete(id);
		}
	}
}

export function createActiveGenerationsStore(): ActiveGenerationsStore {
	const store = new ActiveGenerationsStore();
	setContext(ACTIVE_GENERATIONS_CONTEXT_KEY, store);
	return store;
}

export function useActiveGenerationsStore(): ActiveGenerationsStore {
	return getContext<ActiveGenerationsStore>(ACTIVE_GENERATIONS_CONTEXT_KEY);
}
