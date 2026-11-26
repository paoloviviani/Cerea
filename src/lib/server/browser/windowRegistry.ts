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
 * with `CHAT_REPLICAS` above 1 a turn that lands on another replica does not find the window, and
 * a turn that carried a window id then refuses instead of browsing on a computer (`windowRefusal`
 * in `windowTarget.ts`; with one replica the window is simply gone and computers are used).
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
/** Per window, inbound: messages in 10 s and bytes in a minute. A task sends one answer per call. */
const MAX_MESSAGES_PER_10S = 50;
const MAX_BYTES_PER_MINUTE = 96 * 1024 * 1024;
/** Calls that timed out or were aborted may still be answered late, a few of them. */
const MAX_LATE_ANSWERS = 8;
/** At most this many live windows per user (a window that reconnects replaces its own). */
export const MAX_WINDOWS_PER_USER = 4;
/** A window lease lapses after this long with no call or answer, so a stuck task cannot hold it. */
export const LEASE_IDLE_MS = 5 * 60_000;

const contentBlock = z.union([
	z.object({ type: z.literal("text"), text: z.string().max(MAX_WINDOW_MESSAGE_BYTES) }),
	z.object({
		type: z.literal("image"),
		data: z.string().max(MAX_WINDOW_MESSAGE_BYTES),
		// Only picture types the chat can show; anything else (svg, html, a made-up type) is refused whole.
		mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
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
	leasedBy: object | undefined;
	lastActivity: number;
	late: Set<string>;
	lateAnswers: number;
	recent: Array<[number, number]>;
	closers: Set<() => void>;
}

const windows = new Map<string, Entry>();
const mapKey = (userId: string, windowId: string) => `${userId}:${windowId}`;

/** Whether this user may add a window with this id: below the cap, or it replaces its own. */
export function windowCapacityFor(userId: string, windowId: string): boolean {
	if (windows.has(mapKey(userId, windowId))) return true;
	let n = 0;
	for (const entry of windows.values()) if (entry.userId === userId && entry.open) n += 1;
	return n < MAX_WINDOWS_PER_USER;
}

/** What the app answers when a second driver was refused its panel (`desktop/src/main/cdpBridge.ts`). */
export const WINDOW_BUSY_MESSAGE = "Another task is using this browser.";

export class WindowLimitError extends Error {}

/**
 * Registers a window that authenticated as `userId` on `sessionId`. A window with the same id
 * (the page reconnecting) replaces the old link, which is closed. Throws `WindowLimitError` when
 * the user already has the most windows allowed (the upgrade checked this too, but it awaited
 * the session in between, so two sockets could both have passed).
 */
export function registerWindow(input: {
	userId: string;
	sessionId: string;
	windowId: string;
	/** The grant key `windowGrantKey` derived when the ticket was minted. */
	key: Buffer;
	transport: WindowTransport;
}): BrowserWindow {
	if (!windowCapacityFor(input.userId, input.windowId)) throw new WindowLimitError();
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
		leasedBy: undefined,
		lastActivity: Date.now(),
		late: new Set(),
		lateAnswers: 0,
		recent: [],
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
 * another one: the caller then refuses (`windowRefusal`), it does not fall back to a computer.
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
	const bytesOf = Buffer.byteLength(raw);
	if (bytesOf > MAX_WINDOW_MESSAGE_BYTES) return offend();
	// Inbound budget per window: messages per 10 s and bytes per minute. Past it the window is closed.
	const now = Date.now();
	entry.recent = entry.recent.filter(([t]) => now - t < 60_000);
	entry.recent.push([now, bytesOf]);
	const inTen = entry.recent.filter(([t]) => now - t < 10_000).length;
	const bytes = entry.recent.reduce((n, [, b]) => n + b, 0);
	if (inTen > MAX_MESSAGES_PER_10S || bytes > MAX_BYTES_PER_MINUTE) {
		entry.transport.close(4429, "too many messages");
		dropEntry(entry, "it sent more than a window may");
		return false;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return offend();
	}
	const parsed = windowResponseSchema.safeParse(json);
	if (!parsed.success) return offend();
	const pending = entry.pending.get(parsed.data.id);
	if (!pending) {
		// A late answer to a call that timed out or was aborted is fine, a few times; an answer to
		// an id this process never issued is an offence.
		if (entry.late.delete(parsed.data.id) && ++entry.lateAnswers <= MAX_LATE_ANSWERS) return true;
		return offend();
	}
	entry.lastActivity = now;
	// An answer to a live call: the late-answer allowance starts over.
	entry.lateAnswers = 0;
	entry.pending.delete(parsed.data.id);
	clearTimeout(pending.timer);
	if (pending.signal && pending.onAbort)
		pending.signal.removeEventListener("abort", pending.onAbort);
	if (parsed.data.error) {
		// The app says another task holds its panel: that ends this task (the loop stops with
		// `busy`), it is not a tool failure for the model to retry.
		const busy = parsed.data.error.message === WINDOW_BUSY_MESSAGE;
		pending.reject(
			new BrowserRuntimeError(
				busy
					? WINDOW_BUSY_MESSAGE
					: `The browser in this app reported an error in ${pending.tool}: ${parsed.data.error.message}`,
				busy ? "unavailable" : "tool"
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

function noteLate(entry: Entry, id: string): void {
	entry.late.add(id);
	// Bounded: only the most recent few are remembered.
	if (entry.late.size > MAX_LATE_ANSWERS)
		entry.late.delete(entry.late.values().next().value as string);
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
					noteLate(entry, id);
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
				noteLate(entry, id);
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			entry.lastActivity = Date.now();
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
 * What the loop's keep-alive does for a window: the task is alive (waiting for the user's approval
 * can take an hour), so its lease does not lapse. The lease lapses only when the loop is gone.
 */
export function windowKeepAlive(window: BrowserWindow): () => Promise<void> {
	const entry = window as Entry;
	return async () => {
		if (entry.open) entry.lastActivity = Date.now();
	};
}

/**
 * One task per window, like the lease on a computer's row but in memory, because the window is:
 * held until released or until the window's link ends.
 */
export function windowLeaseStore(): LeaseStore {
	return {
		async acquire(windowId, userId) {
			const entry = windows.get(mapKey(userId.toString(), windowId));
			if (!entry || !entry.open) return null;
			// A lease nobody has used for a while (no call, no answer) is lapsed: a stuck task does not
			// keep the window for good.
			if (entry.leasedBy && Date.now() - entry.lastActivity < LEASE_IDLE_MS) return null;
			const mine = {};
			entry.leasedBy = mine;
			entry.lastActivity = Date.now();
			let held = true;
			const cancel = onWindowClosed(entry, () => {
				held = false;
			});
			return {
				// The link going away is reported by the calls failing with a plain reason, not as a
				// "someone else took the browser" lease loss: the lease is only about other tasks.
				check: async () => entry.leasedBy === mine,
				release: async () => {
					if (!held && !entry.open) return;
					held = false;
					if (entry.leasedBy === mine) entry.leasedBy = undefined;
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
