/**
 * The Cerea view's only bridge (ADR 0122): `window.cereaDesktop.browser = { available, send,
 * onMessage }`, the page's way to the app's own browser. Exposed only to the main frame of a page
 * whose origin is the one this view was made for (`--cerea-origin=`, set per profile by the main
 * process); any other page this view shows (the identity provider's sign-in, say) and every
 * subframe get nothing. The main process checks the sender again on every message: this file
 * narrows what the page can ask, and is not the only guard.
 *
 * The page's JavaScript is not trusted with more than strings: `send` takes one JSON string up to
 * 256 KiB, and the messages that come back are strings too.
 */
import { contextBridge, ipcRenderer } from "electron";

const MAX_CHARS = 256 * 1024;
const origin = process.argv.find((a) => a.startsWith("--cerea-origin="))?.slice(15) ?? "";

if (origin && window === window.top && location.origin === origin) {
	const available = ipcRenderer.sendSync("winbrowser:available") === true;
	const listeners = new Set<(json: string) => void>();
	ipcRenderer.on("winbrowser:message", (_e, json: unknown) => {
		if (typeof json !== "string") return;
		for (const cb of [...listeners]) {
			try {
				cb(json);
			} catch {
				// a page's listener failing is the page's business
			}
		}
	});
	contextBridge.exposeInMainWorld("cereaDesktop", {
		browser: {
			available,
			send(json: unknown): void {
				if (!available || typeof json !== "string" || json.length > MAX_CHARS) return;
				ipcRenderer.send("winbrowser:send", json);
			},
			onMessage(cb: unknown): () => void {
				if (typeof cb !== "function") return () => undefined;
				const fn = cb as (json: string) => void;
				listeners.add(fn);
				return () => void listeners.delete(fn);
			},
		},
	});
}
