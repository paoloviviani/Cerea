import { base } from "$app/paths";
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

export async function* codeAgentStream(
	deviceId: string,
	agentId: string,
	signal: AbortSignal
): AsyncGenerator<AgentStreamUpdate> {
	const source = new EventSource(agentStreamUrl(deviceId, agentId));
	const queue: AgentStreamUpdate[] = [];
	let done = false;
	let wake: (() => void) | null = null;
	const notify = () => {
		wake?.();
		wake = null;
	};

	source.addEventListener("update", (event) => {
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

	// Close ourselves so EventSource does not auto-reconnect after a deliberate end.
	const finish = () => {
		done = true;
		source.close();
		notify();
	};
	source.addEventListener("end", finish);
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
		source.close();
	}
}
