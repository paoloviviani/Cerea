/**
 * Network gate for the execution worker.
 *
 * The sandbox's one job is to make "the code can phone home" false. A Web
 * Worker has no cookies of its own to leak, but it shares the app origin: an
 * unguarded `fetch` from here would carry the user's session cookie to any
 * URL the executed code names, and `micropip` would happily pull wheels from
 * the public Pyodide index. So the gate allowlists exactly one destination —
 * same-origin paths under /pyodide/ (the vendored runtime itself, and any
 * wheels an operator drops there for micropip) — and deletes every other
 * browser-side network surface the worker global scope has.
 *
 * Python-level sockets do not exist in Pyodide (there is no network syscall
 * in wasm), so the JS surface is the whole surface: urllib fails on its own,
 * and `pyfetch`/`micropip`/the `js` module all land on the wrapped `fetch`.
 */

/** Paths under this prefix may be fetched; nothing else can be reached. */
export const ALLOWED_PATH_PREFIX = "/pyodide/";

/** The names this gate removes from the worker global scope. */
export const REMOVED_NETWORK_GLOBALS = [
	"XMLHttpRequest",
	"WebSocket",
	"EventSource",
	"Worker",
	"SharedWorker",
	"ServiceWorkerContainer",
	"navigator" /* only sendBeacon/sendBeacon-like members below */,
] as const;

export function installNetworkGate(scope: typeof globalThis = self): void {
	const rawFetch = scope.fetch;
	if (typeof rawFetch === "function") {
		scope.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			let url: URL;
			try {
				url = new URL(input instanceof Request ? input.url : String(input), scope.location.href);
			} catch {
				return Promise.reject(new TypeError("blocked by the execution sandbox (bad URL)"));
			}
			if (url.origin !== scope.location.origin || !url.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
				return Promise.reject(
					new TypeError(
						`blocked by the execution sandbox: network access is limited to ${ALLOWED_PATH_PREFIX}`
					)
				);
			}
			return rawFetch.call(scope, input, init);
		}) as typeof fetch;
	}

	for (const name of REMOVED_NETWORK_GLOBALS) {
		if (name === "navigator") {
			// navigator itself is harmless; only its request-launching members go
			const nav = (scope as unknown as { navigator?: Record<string, unknown> }).navigator;
			if (nav) {
				delete nav.sendBeacon;
				delete nav.serviceWorker;
				delete nav.requestMIDIAccess;
				delete nav.usb;
				delete nav.serial;
				delete nav.bluetooth;
			}
			continue;
		}
		delete (scope as Record<string, unknown>)[name];
	}

	// A worker cannot reach the DOM, but make the absence explicit for the `js`
	// bridge: no document, no storage, no indexedDB handle.
	const record = scope as Record<string, unknown>;
	for (const name of ["indexedDB", "caches", "document", "localStorage", "sessionStorage"]) {
		delete record[name];
	}
}

/** Test helper: is this URL one the gate would let through? */
export function gateAllows(input: string, origin: string): boolean {
	try {
		const url = new URL(input, origin);
		return url.origin === origin && url.pathname.startsWith(ALLOWED_PATH_PREFIX);
	} catch {
		return false;
	}
}
