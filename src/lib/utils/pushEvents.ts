/**
 * The things a person can be notified about, shared by the server (what to
 * send, whether the person asked for it) and the Settings screen (what to
 * offer). One list, so a new event is one entry here plus its trigger.
 */

export const PUSH_EVENTS = [
	"permission",
	"agentTurn",
	"scheduleRun",
	"backgroundTask",
	"chatTurn",
] as const;

export type PushEvent = (typeof PUSH_EVENTS)[number];

/** Which events are switched on; an absent key means that event's default. */
export type PushEventPrefs = Partial<Record<PushEvent, boolean>>;

export interface PushEventInfo {
	label: string;
	description: string;
	/** On for a person who has just turned notifications on. */
	defaultOn: boolean;
}

/** A turn counts as "long" past this. Shorter ones end while the person is
 * still looking at the screen they started it from. */
export const LONG_TURN_MS = 90_000;

export const PUSH_EVENT_INFO: Record<PushEvent, PushEventInfo> = {
	permission: {
		label: "An agent needs you",
		description: "A coding agent is waiting for your approval or an answer to a question.",
		defaultOn: true,
	},
	agentTurn: {
		label: "A long agent turn finishes",
		description: "A coding agent has been working for more than a minute and a half and stopped.",
		defaultOn: true,
	},
	scheduleRun: {
		label: "A scheduled run finishes",
		description: "A scheduled action ran to its end, or could not run.",
		defaultOn: true,
	},
	backgroundTask: {
		label: "A background task fails",
		description: "A task an agent started in the background ended with an error.",
		defaultOn: true,
	},
	chatTurn: {
		label: "A long chat answer is ready",
		description: "A chat reply that took more than a minute and a half finished.",
		defaultOn: false,
	},
};

/** The person's choice for one event, falling back to its default. */
export function pushEventEnabled(prefs: PushEventPrefs | null | undefined, event: PushEvent) {
	return prefs?.[event] ?? PUSH_EVENT_INFO[event].defaultOn;
}

/** Every event resolved, for sending to the browser. */
export function resolvePushEventPrefs(
	prefs: PushEventPrefs | null | undefined
): Record<PushEvent, boolean> {
	return Object.fromEntries(PUSH_EVENTS.map((e) => [e, pushEventEnabled(prefs, e)])) as Record<
		PushEvent,
		boolean
	>;
}
