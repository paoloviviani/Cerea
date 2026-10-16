import { base } from "$app/paths";
import { codeReauth, flagCodeReauth } from "$lib/stores/codeReauth.svelte";
import { loadCodeStatus } from "$lib/codeApi";
import { onAppResume } from "$lib/utils/appResume";
import { AGENT_STREAM_UPDATE_TYPES, type AgentStreamUpdate } from "$lib/types/CodeAgent";

/**
 * Consume the agent timeline bridge (`api/v2/code/agents/[id]/stream`) as an
 * async iterator of agent frames.
 *
 * The shape mirrors `reattachStream.ts`: EventSource auto-reconnects and
 * resends the last event id, so this surfaces `update` frames and stops on
 * `end` or abort. A fresh subscription starts at `fromSeq=0`, and the bridge
 * replays the daemon's log before tailing — so mounting this iterator is the
 * whole history fetch; no separate snapshot call is needed. The frames are
 * the chat's update shapes (see `types/CodeAgent.ts`), folded into
 * `Message[]` by `consumeAgentUpdates`.
 */

const KNOWN_TYPES = new Set<string>(AGENT_STREAM_UPDATE_TYPES);

function isAgentUpdate(value: unknown): value is AgentStreamUpdate {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && KNOWN_TYPES.has(type);
}

export function agentStreamUrl(deviceId: string, agentId: string): string {
	return `${base}/api/v2/code/agents/${encodeURIComponent(agentId)}/stream?device=${encodeURIComponent(deviceId)}`;
}

/** Consecutive failed (re)connects before the stream gives up and ends, as it
 * always did on a refusal; the person can reopen the chat. */
const MAX_RECONNECTS = 8;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export async function* codeAgentStream(
	deviceId: string,
	agentId: string,
	signal: AbortSignal
): AsyncGenerator<AgentStreamUpdate> {
	let source: EventSource;
	const queue: AgentStreamUpdate[] = [];
	let done = false;
	let wake: (() => void) | null = null;
	let failures = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	const notify = () => {
		wake?.();
		wake = null;
	};

	// Close ourselves so EventSource does not auto-reconnect after a deliberate end.
	const finish = () => {
		done = true;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		source?.close();
		notify();
	};

	const connect = () => {
		retryTimer = null;
		const next = new EventSource(agentStreamUrl(deviceId, agentId));
		source = next;
		next.addEventListener("open", () => {
			failures = 0;
		});
		next.addEventListener("update", (event) => {
			failures = 0;
			try {
				const parsed: unknown = JSON.parse((event as MessageEvent).data);
				// The bridge validates too; this is the backstop for anything that
				// reached the page another way (a cached frame, a proxy's injection).
				if (isAgentUpdate(parsed)) queue.push(parsed);
			} catch {
				// ignore a malformed frame rather than tear down the transcript
			}
			notify();
		});
		next.addEventListener("end", finish);
		// The sign-in behind this stream lapsed (the server schedules this frame
		// at `authTime + 7d` and closes): flip the shared flag, then stop. The
		// panel drops its state and shows the one card.
		next.addEventListener("reauth_required", () => {
			flagCodeReauth();
			finish();
		});
		// A refusal at open closes an EventSource for good and says nothing about
		// why: a stale or missing sign-in (the /code guard's 401), or a server
		// that is restarting (a 502 from the proxy) look the same. Ask `/status`,
		// the one call a stale session may make: it flips the flag if the
		// sign-in is the reason, and then the stream ends. Otherwise the server
		// or the network was only away: reconnect with backoff, and tell the
		// consumer to refold, because the new connection replays the history
		// from the start.
		next.addEventListener("error", () => {
			if (next.readyState !== EventSource.CLOSED || done || next !== source) return;
			next.close();
			void (async () => {
				await loadCodeStatus(true);
				if (done || codeReauth.required) return finish();
				failures += 1;
				if (failures > MAX_RECONNECTS) return finish();
				const wait = Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
				retryTimer = setTimeout(reconnect, wait);
			})();
		});
	};

	const reconnect = () => {
		if (done) return;
		if (retryTimer) clearTimeout(retryTimer);
		queue.push({ type: "reset" } as AgentStreamUpdate);
		connect();
		notify();
	};

	connect();
	// The network came back or the tab woke: a stream waiting out its backoff
	// retries now instead of at the end of the wait.
	const stopResume = onAppResume(() => {
		if (retryTimer) reconnect();
	});
	signal.addEventListener("abort", finish, { once: true });

	try {
		for (;;) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (done) return;
			await new Promise<void>((resolve) => (wake = resolve));
		}
	} finally {
		stopResume();
		finish();
	}
}
