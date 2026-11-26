/**
 * The window browser registry (ADR 0122): the browser in a Cerea desktop window, reached over the
 * window's own WebSocket (`windowChannel.ts`) with no computer and no galopin in between.
 *
 * A window registers itself after it authenticated (a ticket minted for the user's session). The
 * registry holds, in process and only in memory:
 *
 * - the live window for a (user, window id), with the key that signs this window's approval
 *   grants (derived from the session secret, never stored, never sent to the page);
 * - the calls waiting for an answer, as MCP JSON-RPC `tools/call` requests sent down the socket;
 * - the one-task lease of the window and the page its last task left open.
 *
 * Everything that arrives from the window is untrusted: an answer is parsed against a strict shape
 * here, and the contract schemas in `runtimeClient.ts` parse what is inside it. A window that
 * sends anything else is closed after a few offences. The server only ever sends `tools/call` for
 * the contract's own tools (`RUNTIME_TOOLS`).
 *
 * In memory means one replica holds the link, exactly like the machine link (`code/machines.ts`):
 * with `CHAT_REPLICAS` above 1 a turn that lands on another replica does not find the window and
 * browses on a computer as it always did (`windowFor` explains the miss in the log).
 */

import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { BrowserRuntimeError, RUNTIME_TOOLS, type RuntimeToolName } from "./contract";
import { memoryKeptStore, type KeptStore } from "./kept";
import type { LeaseStore } from "./lease";
import type { RuntimeCall } from "./runtimeClient";

/** What the window is called on the card and in the loop's sentences ("... on this app"). */
export const WINDOW_NAME = "this app";

/** A window id: what the page makes, and the header or field it sends back with a turn. */
export const WINDOW_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The one call a window may be sent. */
export const WINDOW_METHOD = "tools/call";
/**
 * The key that signs a window's approval grants: derived from the user's session secret (the
 * session cookie's value, which is HttpOnly: the page cannot read it, the app's main process can)
 * and the window id. Server and app derive it independently; it never crosses the page, so script
 * on the Cerea origin cannot forge a grant. It lasts as long as the session secret.
 */
export function windowGrantKey(sessionSecret: string, windowId: string): Buffer {
	return createHmac("sha256", sessionSecret).update(`cerea-window-grant-key|${windowId}`).digest();
}

/** An answer to one call may carry a screenshot or a download: generous, but bounded. */
export const MAX_WINDOW_MESSAGE_BYTES = 24 * 1024 * 1024;
const CALL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
/** A window that sends this many malformed messages is closed. */
const MAX_OFFENCES = 5;

const contentBlock = z.union([
	z.object({ type: z.literal("text"), text: z.string().max(MAX_WINDOW_MESSAGE_BYTES) }),
	z.object({
		type: z.literal("image"),
		data: z.string().max(MAX_WINDOW_MESSAGE_BYTES),
		mimeType: z.string().max(100),
	}),
]);

/** An MCP `tools/call` result, as the app relays it from the runtime. */
const toolResult = z.object({
	content: z.array(contentBlock).max(16).default([]),
	structuredContent: z.record(z.unknown()).optional(),
	isError: z.boolean().optional(),
});

/** A JSON-RPC response with exactly one of `result` and `error`: the only thing a window may send. */
export const windowResponseSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: z.string().min(1).max(64),
		result: toolResult.optional(),
		error: z.object({ code: z.number().int(), message: z.string().max(2000) }).optional(),
	})
	.refine((r) => (r.result === undefined) !== (r.error === undefined), {
		message: "exactly one of result and error",
	});
export type WindowResponse = z.infer<typeof windowResponseSchema>;

/** What a window offers to the registry: the way to write to it and to close it. */
export interface WindowTransport {
	send(text: string): void;
	close(code: number, reason: string): void;
}

interface Pending {
	tool: RuntimeToolName;
	resolve(value: Awaited<ReturnType<RuntimeCall>>): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export interface BrowserWindow {
	readonly userId: string;
	readonly sessionId: string;
	readonly windowId: string;
	/** Signs this window's approval grants (`windowGrantKey`); the app derives the same one itself. */
	readonly key: Buffer;
	/** The page this window's last task left open: in memory, like the window. */
	readonly kept: KeptStore;
	readonly open: boolean;
}

interface Entry extends BrowserWindow {
	open: boolean;
	transport: WindowTransport;
	pending: Map<string, Pending>;
	offences: number;
	leased: boolean;
	closers: Set<() => void>;
}

const windows = new Map<string, Entry>();
const mapKey = (userId: string, windowId: string) => `${userId}:${windowId}`;

/**
 * Registers a window that authenticated as `userId` on `sessionId`. A window with the same id
 * (the page reconnecting) replaces the old link, which is closed.
 */
export function registerWindow(input: {
	userId: string;
	sessionId: string;
	windowId: string;
	/** The grant key `windowGrantKey` derived when the ticket was minted. */
	key: Buffer;
	transport: WindowTransport;
}): BrowserWindow {
	const key = mapKey(input.userId, input.windowId);
	const old = windows.get(key);
	if (old) {
		old.transport.close(4409, "replaced by a newer connection");
		dropEntry(old, "the window reconnected");
	}
	const entry: Entry = {
		userId: input.userId,
		sessionId: input.sessionId,
		windowId: input.windowId,
		key: input.key,
		kept: memoryKeptStore(),
		open: true,
		transport: input.transport,
		pending: new Map(),
		offences: 0,
		leased: false,
		closers: new Set(),
	};
	windows.set(key, entry);
	return entry;
}

function dropEntry(entry: Entry, why: string): void {
	if (!entry.open) return;
	entry.open = false;
	const key = mapKey(entry.userId, entry.windowId);
	if (windows.get(key) === entry) windows.delete(key);
	for (const [id, pending] of entry.pending) {
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort)
			pending.signal.removeEventListener("abort", pending.onAbort);
		pending.reject(
			new BrowserRuntimeError(
				`The browser in this app is gone (${why}). Nothing was lost; start the task again from the app's window.`,
				"unavailable"
			)
		);
		entry.pending.delete(id);
	}
	for (const close of [...entry.closers]) close();
	entry.closers.clear();
}

/** The window's link ended (the socket closed, the session ended, the app switched profile). */
export function unregisterWindow(window: BrowserWindow, why = "the window was closed"): void {
	dropEntry(window as Entry, why);
}

/**
 * The live window a turn came from, or undefined. It must be this user's, on this session, and
 * the link must be up here. With several replicas a miss may only mean the link is held by
 * another one; the caller then browses on a computer as before.
 */
export function windowFor(
	userId: string,
	sessionId: string,
	windowId: string | undefined
): BrowserWindow | undefined {
	if (!windowId || !WINDOW_ID_PATTERN.test(windowId)) return undefined;
	const entry = windows.get(mapKey(userId, windowId));
	if (!entry || !entry.open || entry.sessionId !== sessionId) return undefined;
	return entry;
}

/**
 * The window a generation request came from, for the `browse` tool: named by the request's
 * `windowId` (the page sends it only while its link is up), never for a scheduled run, and only
 * when it is this user's live window on this session.
 */
export function windowForTurn(
	locals:
		| {
				user?: { _id: { toString(): string } };
				sessionId: string;
				browserWindowId?: string;
				scheduledRun?: unknown;
		  }
		| undefined
): BrowserWindow | undefined {
	if (!locals?.user || locals.scheduledRun) return undefined;
	return windowFor(locals.user._id.toString(), locals.sessionId, locals.browserWindowId);
}

/** Runs `fn` once when the window's link ends (or at once if it already has). Returns a way to cancel. */
export function onWindowClosed(window: BrowserWindow, fn: () => void): () => void {
	const entry = window as Entry;
	if (!entry.open) {
		fn();
		return () => undefined;
	}
	entry.closers.add(fn);
	return () => entry.closers.delete(fn);
}

/**
 * One message from the window. Only answers to calls this process made are accepted; anything
 * that does not parse, or is not an answer, is an offence, and a window that keeps offending is
 * closed. Returns whether the message was acceptable.
 */
export function handleWindowMessage(window: BrowserWindow, raw: string): boolean {
	const entry = window as Entry;
	if (!entry.open) return false;
	const offend = (): false => {
		entry.offences += 1;
		if (entry.offences >= MAX_OFFENCES) {
			entry.transport.close(4400, "malformed messages");
			dropEntry(entry, "it sent messages Cerea could not read");
		}
		return false;
	};
	if (raw.length > MAX_WINDOW_MESSAGE_BYTES) return offend();
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return offend();
	}
	const parsed = windowResponseSchema.safeParse(json);
	if (!parsed.success) return offend();
	const pending = entry.pending.get(parsed.data.id);
	// A late answer to a call that timed out or was aborted is not an offence.
	if (!pending) return true;
	entry.pending.delete(parsed.data.id);
	clearTimeout(pending.timer);
	if (pending.signal && pending.onAbort)
		pending.signal.removeEventListener("abort", pending.onAbort);
	if (parsed.data.error) {
		pending.reject(
			new BrowserRuntimeError(
				`The browser in this app reported an error in ${pending.tool}: ${parsed.data.error.message}`,
				"tool"
			)
		);
		return true;
	}
	const { result } = parsed.data;
	if (!result) return true; // not reachable: the schema needs one of result and error
	const text = result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	pending.resolve({
		text,
		isError: result.isError === true,
		...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
		content: result.content,
	});
	return true;
}

/** The runtime transport of a window: one `tools/call` down the socket, one answer back. */
export function windowCall(window: BrowserWindow): RuntimeCall {
	const entry = window as Entry;
	return (tool, args, signal) =>
		new Promise((resolve, reject) => {
			if (!(RUNTIME_TOOLS as readonly string[]).includes(tool)) {
				return reject(new BrowserRuntimeError(`Unknown browser tool "${tool}".`, "protocol"));
			}
			if (!entry.open) {
				return reject(
					new BrowserRuntimeError("The browser in this app is not connected.", "unavailable")
				);
			}
			if (signal?.aborted) return reject(new Error("Aborted"));
			const id = `c${randomUUID().replace(/-/g, "").slice(0, 20)}`;
			const timer = setTimeout(
				() => {
					entry.pending.delete(id);
					reject(
						new BrowserRuntimeError(
							`The browser in this app did not answer (${tool}).`,
							"unavailable"
						)
					);
				},
				tool === "download" ? DOWNLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS
			);
			const onAbort = () => {
				const p = entry.pending.get(id);
				if (!p) return;
				entry.pending.delete(id);
				clearTimeout(p.timer);
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			entry.pending.set(id, { tool, resolve, reject, timer, onAbort, signal });
			try {
				entry.transport.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						method: WINDOW_METHOD,
						params: { name: tool, arguments: args },
					})
				);
			} catch (err) {
				entry.pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(
					new BrowserRuntimeError(
						`The browser in this app could not be reached: ${String(err)}`,
						"unavailable"
					)
				);
			}
		});
}

/**
 * One task per window, like the lease on a computer's row but in memory, because the window is:
 * held until released or until the window's link ends.
 */
export function windowLeaseStore(): LeaseStore {
	return {
		async acquire(windowId, userId) {
			const entry = windows.get(mapKey(userId.toString(), windowId));
			if (!entry || !entry.open || entry.leased) return null;
			entry.leased = true;
			let held = true;
			const cancel = onWindowClosed(entry, () => {
				held = false;
			});
			return {
				// The link going away is reported by the calls failing with a plain reason, not as a
				// "someone else took the browser" lease loss: the lease is only about other tasks.
				check: async () => true,
				release: async () => {
					if (!held && !entry.open) return;
					held = false;
					entry.leased = false;
					cancel();
				},
			};
		},
	};
}

/** Test seam: forget every window. */
export function _resetWindowsForTests(): void {
	for (const entry of [...windows.values()]) dropEntry(entry, "reset");
	windows.clear();
}
