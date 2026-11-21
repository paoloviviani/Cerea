import type { PermissionRequest } from "$lib/types/machineProtocol";
import type { RelayCardFacts, RelayCardView, RelayOp } from "$lib/types/CodeRelay";

/**
 * The relay card as the browser is given it (ADR 0121 section 5), kept free of every import that
 * reaches a machine link, so the timeline code that draws every ask can use it. `cards.ts` fills it.
 */

/**
 * True for a request that is a relay ask: its metadata HAS a `relay` key (whatever the value: a
 * forged object is still a relay ask, so it is held, drawn only from Cerea's record and never
 * given to the reviewer), or Cerea already holds a view for it.
 */
export function isRelayAsk(request: {
	id?: string;
	sessionId?: string;
	metadata?: Record<string, unknown>;
}): boolean {
	if (request.metadata && Object.hasOwn(request.metadata, "relay")) return true;
	if (request.id === undefined) return false;
	const key = viewKey({ id: request.id, sessionId: request.sessionId });
	return views.has(key) || notes.has(key);
}

// -- the card views, by ask --------------------------------------------------------------------

const MAX_VIEWS = 2000;
export const views = new Map<string, RelayCardView>();

export const viewKey = (request: { id: string; sessionId?: string }) =>
	`${request.sessionId ?? ""}|${request.id}`;

/**
 * Approvable views and the notes of asks that cannot be approved live in two maps with their own
 * caps, so a flood of refused asks can never push a real view out. Either way the record in Mongo
 * (a ticket or a tombstone) is the truth: `primeRelayCards` rebuilds a view from it.
 */
export const notes = new Map<string, RelayCardView>();

function remember(map: Map<string, RelayCardView>, key: string, view: RelayCardView): void {
	map.delete(key);
	map.set(key, view);
	if (map.size > MAX_VIEWS) {
		for (const k of map.keys()) {
			if (map.size <= MAX_VIEWS / 2) break;
			map.delete(k);
		}
	}
}

export function setView(request: { id: string; sessionId?: string }, view: RelayCardView): void {
	const key = viewKey(request);
	if (view.approvable) {
		notes.delete(key);
		remember(views, key, view);
	} else {
		views.delete(key);
		remember(notes, key, view);
	}
}

/** Forget every view (specs). */
export function resetRelayViews(): void {
	views.clear();
	notes.clear();
}

const UNAPPROVABLE: RelayCardView = {
	approvable: false,
	reason: "Cerea has no record of this request, so it cannot be approved from here.",
};

/** The view a relay ask renders from: Cerea's record, or "cannot be approved from here". */
export function relayViewFor(request: { id: string; sessionId?: string }): RelayCardView {
	const key = viewKey(request);
	return views.get(key) ?? notes.get(key) ?? UNAPPROVABLE;
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

export function viewOf(facts: RelayCardFacts, ticket?: string): RelayCardView {
	return { approvable: true, ...(ticket ? { ticket } : {}), ...facts };
}
