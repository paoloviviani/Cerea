/**
 * Pause and resume of a parked `execute_code` run, browser side.
 *
 * The turn runs on the server and waits for this page's answer. A phone that
 * locks its screen or switches apps freezes the page (and the sandbox with it),
 * so the server is told when the page leaves (`reportPaused`) and keeps waiting
 * for a much longer window; when the page comes back the run restarts from the
 * start and posts its result as usual.
 */
import { base } from "$app/paths";

/**
 * Tell the server the page is pausing (or coming back). `sendBeacon` survives
 * the page being hidden or torn down; `fetch` with `keepalive` is the fallback
 * where it is missing or refuses the payload. Never throws.
 */
export function reportPaused(conversationId: string, executionId: string): void {
	const url = `${base}/conversation/${conversationId}/code-execution/paused`;
	const body = JSON.stringify({ executionId });
	try {
		if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
			if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
		}
		void fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => undefined);
	} catch {
		// A lost signal only means the original deadline stands.
	}
}

const STORAGE_PREFIX = "cerea.codeRun.";

/** What the page remembers about a run across a discard and reload of this tab. */
export interface StoredRunPause {
	conversationId: string;
	executionId: string;
	code: string;
	pausedAt: number;
}

function storageOf(): Storage | undefined {
	try {
		return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
	} catch {
		return undefined;
	}
}

export function storeRunPause(entry: StoredRunPause): void {
	try {
		storageOf()?.setItem(STORAGE_PREFIX + entry.executionId, JSON.stringify(entry));
	} catch {
		// Storage is a convenience.
	}
}

export function readRunPause(executionId: string): StoredRunPause | undefined {
	try {
		const raw = storageOf()?.getItem(STORAGE_PREFIX + executionId);
		return raw ? (JSON.parse(raw) as StoredRunPause) : undefined;
	} catch {
		return undefined;
	}
}

export function clearRunPause(executionId: string): void {
	try {
		storageOf()?.removeItem(STORAGE_PREFIX + executionId);
	} catch {
		// Nothing to clear.
	}
}

export interface WakeLockHandle {
	acquire(): Promise<void>;
	release(): void;
}

interface WakeLockSentinelLike {
	release(): Promise<void>;
	addEventListener?(type: "release", listener: () => void): void;
}

/**
 * A screen wake lock for the duration of a run, so the screen does not lock
 * while Python warms up. Best effort in every direction: unsupported, denied,
 * a hidden page, a double acquire or a double release are all quiet no-ops.
 * The browser drops the lock itself when the page hides; the caller acquires
 * again on return.
 */
export function createWakeLock(
	nav:
		| { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }
		| undefined = typeof navigator === "undefined" ? undefined : (navigator as never)
): WakeLockHandle {
	let sentinel: WakeLockSentinelLike | undefined;
	let wanted = false;
	return {
		async acquire() {
			wanted = true;
			if (sentinel || !nav?.wakeLock) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			try {
				const acquired = await nav.wakeLock.request("screen");
				if (!wanted) {
					await acquired.release().catch(() => undefined);
					return;
				}
				sentinel = acquired;
				acquired.addEventListener?.("release", () => {
					if (sentinel === acquired) sentinel = undefined;
				});
			} catch {
				// Denied (low battery, policy) or unsupported: the run goes on without it.
			}
		},
		release() {
			wanted = false;
			const held = sentinel;
			sentinel = undefined;
			void held?.release().catch(() => undefined);
		},
	};
}
