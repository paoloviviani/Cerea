import type { PermissionRequest } from "$lib/types/machineProtocol";
import type { RelayCardFacts, RelayCardView, RelayOp } from "$lib/types/CodeRelay";

/**
 * The relay card as the browser is given it (ADR 0121 section 5), kept free of every import that
 * reaches a machine link, so the timeline code that draws every ask can use it. `cards.ts` fills it.
 */

/** True for a request that claims to be a relay ask. */
export function isRelayAsk(request: { metadata?: Record<string, unknown> }): boolean {
	return request.metadata?.relay === true;
}

// -- the card views, by ask --------------------------------------------------------------------

const MAX_VIEWS = 2000;
export const views = new Map<string, RelayCardView>();

export const viewKey = (request: { id: string; sessionId?: string }) =>
	`${request.sessionId ?? ""}|${request.id}`;

export function setView(request: { id: string; sessionId?: string }, view: RelayCardView): void {
	const key = viewKey(request);
	views.delete(key);
	views.set(key, view);
	if (views.size > MAX_VIEWS) {
		for (const k of views.keys()) {
			if (views.size <= MAX_VIEWS / 2) break;
			views.delete(k);
		}
	}
}

/** Forget every view (specs). */
export function resetRelayViews(): void {
	views.clear();
}

const UNAPPROVABLE: RelayCardView = {
	approvable: false,
	reason: "Cerea has no record of this request, so it cannot be approved from here.",
};

/** The view a relay ask renders from: Cerea's record, or "cannot be approved from here". */
export function relayViewFor(request: { id: string; sessionId?: string }): RelayCardView {
	return views.get(viewKey(request)) ?? UNAPPROVABLE;
}

const VERB: Record<RelayOp, string> = {
	send: "Send a message to a session on another computer",
	read: "Read a session on another computer",
	spawn: "Start a session on another computer",
};

/**
 * The request as the browser is given it: Cerea's view alone, in place of anything galopin wrote
 * in the metadata or the title. The tool is pinned to the op the record names.
 */
export function relayRequest(request: PermissionRequest): PermissionRequest {
	const view = relayViewFor(request);
	const tool =
		view.approvable === true
			? `session_${view.op}`
			: ["session_send", "session_read", "session_spawn"].includes(request.tool)
				? request.tool
				: "session_send";
	return {
		...request,
		tool,
		title: view.approvable === true ? VERB[view.op] : "A request to another computer",
		metadata: { relay: view },
	};
}

export function viewOf(facts: RelayCardFacts): RelayCardView {
	return { approvable: true, ...facts };
}
