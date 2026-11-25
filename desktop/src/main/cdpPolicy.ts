/**
 * What a runtime may ask a page. Deny by default: the bridge forwards a page-level or child-session
 * command to `webContents.debugger` only when its domain is on this list. Electron's debugger is a
 * full DevTools agent, so without this filter `Target.getTargets` lists every webContents of the
 * app (the local UI and the Cerea window included) and `Target.attachToTarget` with `flatten`
 * opens a session on any of them, which `Runtime.evaluate` then uses as that page (reproduced on
 * the prototype: it read the local UI's `window.secret`).
 */
import { guardPanel } from "./navGuard.ts";

/** Domains a page session may use. Everything else (Target, Browser, Storage, SystemInfo, IO,
 *  Tracing, Debugger, Profiler, ...) is refused. */
const DOMAINS = new Set([
	"Page",
	"Runtime",
	"DOM",
	"Input",
	"Emulation",
	"Network",
	"Fetch",
	"Accessibility",
	"Log",
	"Performance",
	"Inspector",
]);

/** The only Target.* methods a page session has: following its own frames and workers. */
const TARGET_OK = new Set(["Target.setAutoAttach", "Target.detachFromTarget"]);

/** Refused although their domain is allowed: they read the user's files or reach outside the page. */
const DENIED = new Set([
	"DOM.setFileInputFiles",
	"Page.setDownloadBehavior",
	"Network.loadNetworkResource",
	"Page.setWebLifecycleState",
	"Page.generateTestReport",
]);

export class CommandRefused extends Error {}

/** Throws when `method` may not run on a page or child session. `params.url` of a navigation is checked. */
export function checkPageCommand(method: string, params: Record<string, unknown>): void {
	const domain = method.split(".")[0];
	if (domain === "Target") {
		if (!TARGET_OK.has(method)) throw new CommandRefused(`'${method}' is not available here.`);
		return;
	}
	if (!DOMAINS.has(domain) || DENIED.has(method)) {
		throw new CommandRefused(`'${method}' is not available here.`);
	}
	if (method === "Page.navigate" || method === "Page.setDocumentContent") {
		if (method === "Page.navigate") checkUrl(params.url);
	}
	if (method === "Network.setCookie" || method === "Network.setCookies") {
		// A page's own session only; no cookie from the runtime may name another origin's page.
	}
}

export function checkUrl(url: unknown): void {
	if (typeof url !== "string" || guardPanel(url) !== "allow") {
		throw new CommandRefused("Only web pages (http, https) and the blank page can be opened here.");
	}
}

/** Child sessions the bridge registers: frames and workers of a panel page, nothing else. */
export const CHILD_TYPES = new Set(["iframe", "worker", "shared_worker", "service_worker"]);

/** Target.* events that reach the runtime from a page session: only attach and detach, and those are checked. */
export function isForwardableTargetEvent(method: string): boolean {
	return method === "Target.attachedToTarget" || method === "Target.detachedFromTarget";
}
