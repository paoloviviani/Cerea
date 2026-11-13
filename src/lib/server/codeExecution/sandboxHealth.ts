import { logger } from "$lib/server/logger";
import { sandboxSettings } from "$lib/server/sandbox/boot";
import { SandboxClient } from "$lib/server/sandbox/client";

/**
 * Whether the sandbox manager is configured and answering, as `executionBackend()` needs it: a
 * synchronous answer from a cache that a background probe keeps fresh. Unknown counts as not
 * usable, so a deployment that has not yet heard from its manager runs code in the browser.
 *
 * The switch is logged when it flips, never per call.
 */
const TTL_MS = 30_000;
const FRESH_MS = 5_000;

let state = { ok: false, at: 0 };
let probing: Promise<boolean> | null = null;
let announced: boolean | null = null;

/** Probe now (or join the probe already running) and return the answer. */
export function probeSandboxHealth(): Promise<boolean> {
	const settings = sandboxSettings();
	if (!settings.config) {
		state = { ok: false, at: Date.now() };
		return Promise.resolve(false);
	}
	probing ??= new SandboxClient({ url: settings.config.url, token: settings.config.token })
		.health()
		.then((h) => h.status === "ok")
		.catch(() => false)
		.then((ok) => {
			state = { ok, at: Date.now() };
			if (announced !== ok) {
				announced = ok;
				if (ok) logger.info("[sandbox] manager reachable: execute_code runs on the server");
				else
					logger.warn(
						"[sandbox] manager unreachable or unhealthy: execute_code runs in the browser"
					);
			}
			return ok;
		})
		.finally(() => {
			probing = null;
		});
	return probing;
}

/** Is the manager answering? The cached answer while it is fresh (a few seconds), else a probe. */
export function sandboxHealthyNow(): Promise<boolean> {
	if (Date.now() - state.at < FRESH_MS)
		return Promise.resolve(state.ok && !!sandboxSettings().config);
	return probeSandboxHealth();
}

/** The cached answer; a stale one starts a refresh. */
export function sandboxUsable(): boolean {
	if (!sandboxSettings().config) return false;
	if (Date.now() - state.at > TTL_MS) void probeSandboxHealth();
	return state.ok;
}

/** For tests. */
export function resetSandboxHealth(ok = false, at = Date.now()): void {
	state = { ok, at };
	probing = null;
	announced = null;
}
