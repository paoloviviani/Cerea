import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { isFirstTurn, type FirstTurnSubagent } from "$lib/utils/firstTurnSubagent";

/**
 * Answers "is this ask from a subagent's first turn" by reading the
 * subagent's transcript once per ask (`load`), and remembering the answer for
 * that ask only: a later ask from the same subagent is read again, since the
 * subagent may have had its second turn by then. A failed read is a "no".
 */
export class FirstTurnTracker implements FirstTurnSubagent {
	childId?: string;
	#known = $state<Record<string, boolean>>({});
	#inflight = new Set<string>();
	#load: (childId: string) => Promise<AgentStreamUpdate[]>;

	constructor(load: (childId: string) => Promise<AgentStreamUpdate[]>, childId?: string) {
		this.#load = load;
		this.childId = childId;
	}

	isFirst(childId: string, askId: string): boolean {
		return this.#known[`${childId}:${askId}`] === true;
	}

	ensure(childId: string, askId: string): void {
		const key = `${childId}:${askId}`;
		if (key in this.#known || this.#inflight.has(key)) return;
		this.#inflight.add(key);
		void this.#load(childId)
			.then((updates) => (this.#known[key] = isFirstTurn(updates)))
			.catch(() => (this.#known[key] = false))
			.finally(() => this.#inflight.delete(key));
	}
}
