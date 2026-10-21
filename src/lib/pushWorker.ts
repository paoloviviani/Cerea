/**
 * The service worker's decisions, kept apart from the worker's globals so they
 * can be tested as plain functions (`src/service-worker.ts` is the thin shell
 * that wires them to `push` and `notificationclick`).
 *
 * The worker does three things and nothing else: show a notification for a
 * push, skip it when the person is already looking at the app, and open the
 * right place when it is tapped. It has no `fetch` handler, so it changes
 * nothing about how pages and assets load.
 */

/** What the server sends (`PushPayload` in `server/push/notify.ts`). */
export interface WorkerPayload {
	v: 1;
	title: string;
	body: string;
	url: string;
	icon?: string;
	tag?: string;
	event: string;
}

export function parsePayload(text: string | null | undefined): WorkerPayload | null {
	if (!text) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (v["v"] !== 1 || typeof v["title"] !== "string" || typeof v["url"] !== "string") return null;
	return {
		v: 1,
		title: v["title"],
		body: typeof v["body"] === "string" ? v["body"] : "",
		url: v["url"],
		...(typeof v["icon"] === "string" ? { icon: v["icon"] } : {}),
		...(typeof v["tag"] === "string" ? { tag: v["tag"] } : {}),
		event: typeof v["event"] === "string" ? v["event"] : "",
	};
}

export interface WindowState {
	visibilityState: string;
	focused: boolean;
}

/**
 * Whether to show the notification. Not when a window of the app is both
 * visible and focused: the person is looking at it, and the app already shows
 * what happened. The server cannot know that, which is why the check lives
 * here. The test notification is the exception, since its whole job is to
 * prove the path works.
 */
export function shouldShow(payload: WorkerPayload, windows: readonly WindowState[]): boolean {
	if (payload.event === "test") return true;
	return !windows.some((w) => w.visibilityState === "visible" && w.focused);
}

export function notificationOptions(payload: WorkerPayload): NotificationOptions {
	return {
		body: payload.body,
		...(payload.icon ? { icon: payload.icon } : {}),
		...(payload.tag ? { tag: payload.tag } : {}),
		// Same-tag notifications replace one another; renotify so a replacement
		// still makes the device ring once.
		...(payload.tag ? { renotify: true } : {}),
		data: { url: payload.url },
	} as NotificationOptions;
}

/**
 * Where a tap opens: the payload's path, resolved against the worker's origin,
 * and only if it stays inside the worker's scope. A push is trusted to say
 * which page of this app, not to send the person anywhere else.
 */
export function safeTarget(url: unknown, origin: string, scopePath: string): string {
	const fallback = new URL(scopePath, origin).href;
	if (typeof url !== "string") return fallback;
	try {
		const target = new URL(url, origin);
		if (target.origin !== origin) return fallback;
		if (
			!target.pathname.startsWith(scopePath.replace(/\/?$/, "/")) &&
			target.pathname !== scopePath.replace(/\/$/, "")
		) {
			return fallback;
		}
		return target.href;
	} catch {
		return fallback;
	}
}

export interface ClientLike {
	url: string;
	focused?: boolean;
	visibilityState?: string;
}

/** The window to reuse for a tap: a focused one, else a visible one, else any. */
export function pickClient<T extends ClientLike>(clients: readonly T[]): T | undefined {
	return (
		clients.find((c) => c.focused) ??
		clients.find((c) => c.visibilityState === "visible") ??
		clients[0]
	);
}
