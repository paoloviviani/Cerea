/**
 * What a local server (ADR 0102) is known to speak, so a reconnect does not pay for finding out
 * again, and how long finding out may take the first time.
 *
 * A stdio server that ignores an unknown pre-initialize request (the probe of the 2026 era)
 * never answers it. The SDK would wait its default request timeout, 60 s, before reading that
 * silence as "legacy", and a chat that waits that long on a connector looks broken. A server
 * that is going to answer the probe does so as soon as its process is up, so a short wait is
 * enough, and what it taught us is remembered here.
 */

/**
 * How long the era probe on a local channel waits for an answer. Long enough for a process
 * that has to start (`npx` resolving a package from its cache), far short of the SDK's 60 s.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 3_000;

/** A remembered era is re-checked after this, so a server upgraded to the newer protocol is noticed. */
const ERA_TTL_MS = 60 * 60_000;

export type LocalEra = "legacy" | "modern";

type Remembered = { era: LocalEra; fingerprint?: string; at: number };

// Keyed by the local server url, which is (person, device, server) by construction.
const remembered = new Map<string, Remembered>();

/** Whether two fingerprints disagree; one that is unknown never does. */
function changed(a?: string, b?: string): boolean {
	return a !== undefined && b !== undefined && a !== b;
}

export function rememberLocalEra(url: string, era: LocalEra, fingerprint?: string): void {
	remembered.set(url, { era, fingerprint, at: Date.now() });
}

/** The era last seen on this server, unless its entry changed or the memory is old. */
export function knownLocalEra(url: string, fingerprint?: string): LocalEra | undefined {
	const known = remembered.get(url);
	if (!known) return undefined;
	if (Date.now() - known.at > ERA_TTL_MS || changed(known.fingerprint, fingerprint)) {
		remembered.delete(url);
		return undefined;
	}
	return known.era;
}

/** The server's entry changed or went away (its channel closed with reason `config`). */
export function forgetLocalEra(url: string): void {
	remembered.delete(url);
}

export function resetLocalEras(): void {
	remembered.clear();
}
