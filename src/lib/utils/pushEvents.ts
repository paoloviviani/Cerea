/**
 * The things a person can be notified about, shared by the server (what to
 * send, whether the person asked for it) and the Settings screen (what to
 * offer; the words are messages, `settings.notifications.event.*`). One
 * list, so a new event is one entry here plus its trigger.
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
	/** On for a person who has just turned notifications on. */
	defaultOn: boolean;
}

/** A turn counts as "long" past this. Shorter ones end while the person is
 * still looking at the screen they started it from. */
export const LONG_TURN_MS = 90_000;

export const PUSH_EVENT_INFO: Record<PushEvent, PushEventInfo> = {
	permission: {
		defaultOn: true,
	},
	agentTurn: {
		defaultOn: true,
	},
	scheduleRun: {
		defaultOn: true,
	},
	backgroundTask: {
		defaultOn: true,
	},
	chatTurn: {
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
