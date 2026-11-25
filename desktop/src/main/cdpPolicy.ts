/**
 * What a runtime may ask a page. Deny by default: the bridge forwards a page-level or child-session
 * command to `webContents.debugger` only when its domain is on this list. Electron's debugger is a
 * full DevTools agent, so without this filter `Target.getTargets` lists every webContents of the
 * app (the local UI and the Cerea window included) and `Target.attachToTarget` with `flatten`
 * opens a session on any of them, which `Runtime.evaluate` then uses as that page (reproduced on
 * the prototype: it read the local UI's `window.secret`).
 */
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
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
	// Reads a local file's size and type: nothing in a web page needs it.
	"DOM.getFileInfo",
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
	if (method === "Page.navigate") checkUrl(params.url);
	// A drop carrying file paths hands the page those local files (the debugger client reads them),
	// which is what DOM.setFileInputFiles would do: refused the same way. A drag of text or a link is fine.
	if (method === "Input.dispatchDragEvent") {
		const files = (params.data as { files?: unknown } | undefined)?.files;
		if (files !== undefined && !(Array.isArray(files) && files.length === 0)) {
			throw new CommandRefused("Dropping files is not available here.");
		}
	}
}

/**
 * Where the runtime may ask the app to save downloads: a directory it made itself under a temp
 * directory (`cerea-browser-*`, or Playwright's `playwright-artifacts-*`). `roots` are the temp
 * directories to accept (the app's and the runtime's can differ when TMPDIR is set).
 */
export function downloadDirOk(
	dir: string,
	roots: string[] = [tmpdir(), "/tmp", "/var/tmp", process.env.TMPDIR ?? ""]
): boolean {
	if (!isAbsolute(dir) || dir.includes("\0") || dir.split(/[\\/]/).includes("..")) return false;
	const norm = resolve(dir);
	if (!/^(cerea-browser-|playwright-artifacts-)[A-Za-z0-9_.-]+$/.test(basename(norm))) return false;
	const parent = dirname(norm);
	return roots.some((r) => r && resolve(r) === parent);
}

/**
 * The directory itself must be safe to write downloads into: a real directory (not a symlink to
 * somewhere else), owned by this user, that no one else can write to (a shared temp directory is
 * where another user could have made or swapped it).
 */
export function downloadDirSafe(
	dir: string,
	uid: number | undefined = process.getuid?.()
): boolean {
	try {
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.isSymbolicLink()) return false;
		if (uid !== undefined && st.uid !== uid) return false;
		return (st.mode & 0o022) === 0;
	} catch {
		return false;
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
