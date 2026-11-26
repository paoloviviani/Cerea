/**
 * The page's side of the desktop app's direct browser link (ADR 0122).
 *
 * Inside the Cerea desktop app the page may find `window.cereaDesktop.browser`, a narrow bridge
 * the app puts on the Cerea view's main frame when its origin is the profile's server (nothing
 * else gets it). `available` says the app can run a browser for this page. The page then opens
 * the window browser WebSocket and relays text between the two ends without reading it: down,
 * what the server sends is passed to the app; up, what the app sends is passed to the server.
 * The server and the app each validate their own side; this file is a pipe, and everything it
 * relays is untrusted by both.
 *
 * Outside the app, with the feature off for this user, or when the server refuses, nothing runs.
 */

export interface CereaDesktopBrowser {
	available: boolean;
	send(json: string): void;
	onMessage(cb: (json: string) => void): () => void;
}

declare global {
	interface Window {
		cereaDesktop?: { browser?: CereaDesktopBrowser };
	}
}

/** The app's browser bridge, when this page is in the app and the app can run one. */
export function desktopBrowser(
	win: Pick<Window, "cereaDesktop"> = window
): CereaDesktopBrowser | undefined {
	const b = win.cereaDesktop?.browser;
	return b && b.available === true ? b : undefined;
}

let linkedWindowId: string | undefined;

/** This window's id while its browser link is up, else undefined: what a turn sends with it. */
export function currentWindowId(): string | undefined {
	return linkedWindowId;
}

const newWindowId = () => crypto.randomUUID().replace(/-/g, "");

export interface LinkOptions {
	/** The app's base path (`""` or `"/chat"`). */
	base: string;
	bridge?: CereaDesktopBrowser;
	fetchFn?: typeof fetch;
	socketFactory?: (url: string) => WebSocket;
	origin?: string;
	windowId?: string;
	/** Back-off between reconnects (ms), first and last. */
	backoff?: [number, number];
}

/** Starts the link and returns the function that stops it. Does nothing outside the app. */
export function startDesktopBrowserLink(opts: LinkOptions): () => void {
	const found = opts.bridge ?? (typeof window === "undefined" ? undefined : desktopBrowser());
	if (!found) return () => undefined;
	const bridge: CereaDesktopBrowser = found;
	const fetchFn = opts.fetchFn ?? fetch;
	const origin = opts.origin ?? location.origin;
	const windowId = opts.windowId ?? newWindowId();
	const [minWait, maxWait] = opts.backoff ?? [1000, 30_000];
	const make = opts.socketFactory ?? ((url: string) => new WebSocket(url));
	let stopped = false;
	let socket: WebSocket | undefined;
	let wait = minWait;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const retry = () => {
		if (stopped) return;
		timer = setTimeout(() => void connect(), wait);
		wait = Math.min(wait * 2, maxWait);
	};

	async function connect(): Promise<void> {
		if (stopped) return;
		let ticket: string;
		let cookie = "";
		try {
			const res = await fetchFn(`${opts.base}/api/v2/browser/window/ticket`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ windowId }),
			});
			// Off for this deployment or this user, or signed out: nothing to link, and no retries.
			if (res.status === 404 || res.status === 401 || res.status === 403) return;
			if (!res.ok) return retry();
			const body = (await res.json()) as { ticket?: unknown; cookie?: unknown };
			if (typeof body.ticket !== "string" || typeof body.cookie !== "string") return retry();
			ticket = body.ticket;
			cookie = body.cookie;
		} catch {
			return retry();
		}
		if (stopped) return;
		const url = `${origin.replace(/^http/, "ws")}${opts.base}/api/v2/browser/window?ticket=${encodeURIComponent(ticket)}`;
		const ws = make(url);
		socket = ws;
		let unsubscribe: (() => void) | undefined;
		ws.onopen = () => {
			wait = minWait;
			linkedWindowId = windowId;
			// Tells the app which window this is and which cookie holds the session secret, so it
			// derives the window's grant key itself. The page never sees the secret or the key.
			bridge.send(
				JSON.stringify({ jsonrpc: "2.0", method: "cerea/window", params: { windowId, cookie } })
			);
			unsubscribe = bridge.onMessage((text) => {
				if (ws.readyState === 1 && typeof text === "string") ws.send(text);
			});
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data === "string") bridge.send(ev.data);
		};
		ws.onclose = (ev) => {
			unsubscribe?.();
			if (linkedWindowId === windowId) linkedWindowId = undefined;
			if (socket === ws) socket = undefined;
			// Replaced by a newer connection of the same window: that one is the link now.
			if (ev.code === 4409) return;
			retry();
		};
		ws.onerror = () => undefined;
	}

	void connect();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		socket?.close();
		if (linkedWindowId === windowId) linkedWindowId = undefined;
	};
}
