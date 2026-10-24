import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Client } from "@modelcontextprotocol/client";
import { createMcpClient, type McpClientKind } from "./client";
import type { McpServerConfig } from "./httpClient";
import { mcpFetch } from "$lib/server/urlSafety";
import { isLocalServerUrl, parseLocalServerUrl } from "./localUrl";
import {
	forgetLocalEra,
	knownLocalEra,
	LOCAL_PROBE_TIMEOUT_MS,
	rememberLocalEra,
} from "./localEra";

type PoolEntry = {
	client: Client;
	lastUsedAt: number;
	activeCalls: number;
	/** Evicted from the pool; closed once its last in-flight call finishes. */
	retired?: boolean;
};

const pool = new Map<string, PoolEntry>();

/**
 * Entries by client, so retain/release still find one after it leaves the pool, and
 * evicted clients with calls still running can be closed by the last one to finish.
 */
const entries = new Map<Client, PoolEntry>();

// Reuse a recently-used client as-is; ping it first if it has been idle longer than this,
// since proxies / load balancers silently reap idle connections.
const PING_AFTER_IDLE_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;
// Close clients idle longer than this. Must stay well above MCP tool timeouts so the sweeper
// never closes a client with an in-flight call.
const IDLE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

let sweeper: ReturnType<typeof setInterval> | undefined;

// Dispose of a still-healthy pooled client. Per the MCP Streamable HTTP spec, clients
// SHOULD explicitly terminate sessions they no longer need (HTTP DELETE) before dropping
// the connection; servers that don't support it reply 405, which the SDK treats as ok.
async function disposeClient(client: Client) {
	const transport = client.transport;
	if (transport instanceof StreamableHTTPClientTransport) {
		await transport.terminateSession().catch(() => {});
	}
	await client.close?.().catch(() => {});
}

function ensureSweeper() {
	if (sweeper) return;
	sweeper = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of pool) {
			if (entry.activeCalls === 0 && now - entry.lastUsedAt > IDLE_TTL_MS) {
				pool.delete(key);
				entries.delete(entry.client);
				void disposeClient(entry.client);
			}
		}
	}, SWEEP_INTERVAL_MS);
	sweeper.unref?.();
}

function keyOf(server: McpServerConfig, isolation?: string, kind: McpClientKind = "session") {
	const headers = Object.entries(server.headers ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join("|\u0000|");
	// The kind is part of the key, not decoration: it is sent once at initialize,
	// so a connection opened as one identity would otherwise be handed to a
	// caller that means to be the other, and the server would see the wrong name.
	return `${server.url}|${headers}|${isolation ?? ""}|${kind}`;
}

/**
 * A client on a channel of the person's own machine (ADR 0102): never the HTTP and SSE
 * fallbacks, which mean nothing for it. Negotiates the protocol era like any other client, but
 * only as long as a process takes to start (`localEra.ts`), and remembers the outcome: a server
 * known to be legacy is connected as one directly, without a probe it would ignore.
 */
async function connectLocal(url: string, kind: McpClientKind): Promise<Client> {
	// Imported on demand: the machine link pulls in the database, which a pool user that never
	// meets a local server should not need.
	const { createLocalTransport } = await import("./localTransport");
	const { localServerFingerprint } = await import("./local");
	const target = parseLocalServerUrl(url);
	const fingerprint = target ? localServerFingerprint(target.deviceId, target.server) : undefined;
	const attempt = async (negotiate: boolean) => {
		const client = createMcpClient(kind, { negotiate, probeTimeoutMs: LOCAL_PROBE_TIMEOUT_MS });
		try {
			await client.connect(await createLocalTransport(url, () => forgetLocalEra(url)));
		} catch (err) {
			await client.close?.().catch(() => {});
			throw err;
		}
		return client;
	};
	// The era is remembered once a `tools/list` has been answered on the connection, not when
	// it connects: a cold start that missed the probe may have settled on the wrong era, and
	// only a connection that then did its job proves the era it ended up with.
	const rememberOnListing = (client: Client) => {
		const listTools = client.listTools.bind(client);
		client.listTools = (async (...args: Parameters<Client["listTools"]>) => {
			const response = await listTools(...args);
			const era = client.getProtocolEra();
			// An empty listing proves nothing: it is what a connection on the wrong era answers.
			if (
				Array.isArray(response?.tools) &&
				response.tools.length > 0 &&
				(era === "legacy" || era === "modern")
			) {
				rememberLocalEra(url, era, fingerprint);
			}
			return response;
		}) as Client["listTools"];
		return client;
	};
	if (knownLocalEra(url, fingerprint) === "legacy") return rememberOnListing(await attempt(false));
	try {
		return rememberOnListing(await attempt(true));
	} catch (err) {
		if (!/time(d)? ?out/i.test(err instanceof Error ? err.message : String(err))) throw err;
		return rememberOnListing(await attempt(false));
	}
}

export async function getClient(
	server: McpServerConfig,
	signal?: AbortSignal,
	isolation?: string,
	kind: McpClientKind = "session"
): Promise<Client> {
	const key = keyOf(server, isolation, kind);
	let existing = pool.get(key);
	if (existing && isLocalServerUrl(server.url) && !existing.client.transport) {
		// Its connection ended since the last use (a local server's channel closed, the machine
		// dropped): nothing to ping, and handing it out would fail the caller. Start afresh.
		pool.delete(key);
		entries.delete(existing.client);
		existing = undefined;
	}
	if (existing) {
		if (Date.now() - existing.lastUsedAt <= PING_AFTER_IDLE_MS) {
			existing.lastUsedAt = Date.now();
			return existing.client;
		}
		try {
			await existing.client.ping({ signal, timeout: PING_TIMEOUT_MS });
			existing.lastUsedAt = Date.now();
			return existing.client;
		} catch (err) {
			if (signal?.aborted) throw err;
			// Stale connection; evict it (unless a concurrent caller already replaced it) and reconnect.
			if (pool.get(key) === existing) pool.delete(key);
			existing.client.close?.().catch(() => {});
		}
	}

	if (isLocalServerUrl(server.url)) {
		const client = await connectLocal(server.url, kind);
		const entry: PoolEntry = { client, lastUsedAt: Date.now(), activeCalls: 0 };
		pool.set(key, entry);
		entries.set(client, entry);
		ensureSweeper();
		return client;
	}

	let firstError: unknown;
	const client = createMcpClient(kind);
	const url = new URL(server.url);
	// Pooled clients outlive the request that created them, so never bind the per-request
	// abort signal to the transport. Per-call cancellation goes through RequestOptions instead.
	const requestInit: RequestInit = { headers: server.headers };
	try {
		try {
			await client.connect(
				new StreamableHTTPClientTransport(url, { requestInit, fetch: mcpFetch })
			);
		} catch (httpErr) {
			// Remember the original HTTP transport error so we can surface it if the fallback also fails.
			// Today we always show the SSE message, which is misleading when the real failure was HTTP (e.g. 500).
			firstError = httpErr;
			await client.connect(new SSEClientTransport(url, { requestInit, fetch: mcpFetch }));
		}
	} catch (err) {
		try {
			await client.close?.();
		} catch {}
		// Prefer the HTTP error if both transports fail; otherwise fall back to the last error.
		if (firstError) {
			const message =
				"HTTP transport failed: " +
				String(firstError instanceof Error ? firstError.message : firstError) +
				"; SSE fallback failed: " +
				String(err instanceof Error ? err.message : err);
			throw new Error(message, { cause: err instanceof Error ? err : undefined });
		}
		throw err;
	}

	const entry: PoolEntry = { client, lastUsedAt: Date.now(), activeCalls: 0 };
	pool.set(key, entry);
	entries.set(client, entry);
	ensureSweeper();
	return client;
}

/** Mark a pooled client as having an in-flight call so the sweeper won't close it. */
export function retainClient(client: Client) {
	const entry = entries.get(client);
	if (entry) entry.activeCalls++;
}

export function releaseClient(client: Client) {
	const entry = entries.get(client);
	if (!entry) return;
	entry.activeCalls = Math.max(0, entry.activeCalls - 1);
	entry.lastUsedAt = Date.now();
	// A client is only evicted because it looked broken to one caller. Closing it while
	// another conversation is still mid-call would cancel that call too, so the last one
	// out closes the door.
	if (entry.retired && entry.activeCalls === 0) {
		entries.delete(client);
		void disposeClient(client);
	}
}

export async function drainPool() {
	for (const [key, entry] of pool) {
		await disposeClient(entry.client);
		entries.delete(entry.client);
		pool.delete(key);
	}
}

/**
 * Take a client out of circulation. Returns it only when nothing else is using it, so the
 * caller cannot close a connection another conversation is still talking over.
 */
export function evictFromPool(server: McpServerConfig, isolation?: string): Client | undefined {
	const key = keyOf(server, isolation);
	const entry = pool.get(key);
	if (!entry) return undefined;
	pool.delete(key);
	if (entry.activeCalls > 0) {
		entry.retired = true;
		return undefined;
	}
	entries.delete(entry.client);
	return entry.client;
}

/**
 * Throw away what is known about a local server's connection: its pooled client (closed once
 * no call is using it) and the era remembered for it. For a listing that failed or came back
 * empty, so the next try starts a fresh process and finds the era out again.
 */
export function forgetLocalConnection(server: McpServerConfig): void {
	forgetLocalEra(server.url);
	evictFromPool(server)
		?.close?.()
		.catch(() => {});
}

/**
 * A connection an unsolicited `elicitation/create` can be attributed on. A legacy server
 * pushes one down the connection with nothing tying it to a call, so it can only be routed
 * when every call on that connection belongs to the same conversation; sharing one instead
 * means a prompt raised for one chat gets declined because another chat is also mid-call.
 * A modern server answers the call itself, so it keeps the shared connection.
 *
 * A local server (a process on the person's machine) never gets a connection of its own per
 * conversation: each one would be a new server process there, started on every new chat and
 * counted against the machine's per-server channel cap. It keeps the one shared connection
 * and `leaseConnection` makes its prompts attributable instead.
 */
export async function getAttributableClient(
	server: McpServerConfig,
	conversationId: string,
	signal?: AbortSignal,
	kind: McpClientKind = "session"
): Promise<{ client: Client; isolation?: string }> {
	if (isLocalServerUrl(server.url)) {
		return { client: await getClient(server, signal, undefined, kind) };
	}
	const isolation = `conversation:${conversationId}`;
	if (!pool.has(keyOf(server, isolation, kind))) {
		const shared = await getClient(server, signal, undefined, kind);
		if (shared.getProtocolEra() === "modern") return { client: shared };
	}
	return { client: await getClient(server, signal, isolation, kind), isolation };
}

type Lease = {
	owner?: object;
	holders: number;
	waiting: Array<{ owner: object; grant: () => void }>;
};

const leases = new WeakMap<Client, Lease>();

/**
 * Makes the conversation whose call is in flight the only one on a connection, which is what
 * lets an unsolicited `elicitation/create` from a legacy server be attributed to it
 * (`elicitation.ts` routes it to the calls in flight, and declines when they belong to more
 * than one conversation).
 *
 * Calls of one owner share the connection as they always did. A call from another owner waits
 * until the connection is free of the first one's calls, in arrival order (a newcomer from the
 * current owner queues behind a waiting call too, so nobody is starved). The owner is the
 * elicitation sink, the same identity the router compares. Waiting ends when `signal` aborts.
 * Release by calling the returned function once.
 */
export async function leaseConnection(
	client: Client,
	owner: object,
	signal?: AbortSignal
): Promise<() => void> {
	let lease = leases.get(client);
	if (!lease) {
		lease = { holders: 0, waiting: [] };
		leases.set(client, lease);
	}
	const state = lease;
	const take = () => {
		state.owner = owner;
		state.holders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.holders--;
			if (state.holders === 0) state.owner = undefined;
			// Wake the next in line, and whoever behind it belongs to the same owner.
			while (state.waiting.length > 0) {
				const next = state.waiting[0];
				if (state.holders > 0 && state.owner !== next.owner) break;
				state.waiting.shift();
				next.grant();
			}
		};
	};
	if (state.waiting.length === 0 && (state.holders === 0 || state.owner === owner)) return take();

	return new Promise<() => void>((resolve, reject) => {
		const waiter = {
			owner,
			// Taken here, not when the promise settles, so the next wake-up sees the new owner.
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(take());
			},
		};
		const onAbort = () => {
			const at = state.waiting.indexOf(waiter);
			if (at >= 0) state.waiting.splice(at, 1);
			reject(
				signal?.reason ?? new Error("The call was cancelled while waiting for the connector.")
			);
		};
		state.waiting.push(waiter);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}
