/**
 * The live view of a running browse task (ADR 0116 phase 2a): frames from the machine's browser to
 * the owner's page, and the owner's input back, on the browse task's own terms.
 *
 * - A task registers itself while it runs (`registerLiveTask`) and is gone when it ends, so the
 *   routes can only ever reach a running task; the owner is the only user that can find one
 *   (`liveTaskFor` answers nothing for anyone else, so it is a 404, not a 403).
 * - Frames arrive from the machine as binary link frames (`subscribeBrowserFrames`) and are passed
 *   straight on to the viewers: not stored, not logged. The first viewer starts the machine's
 *   screencast, the last one stops it; a periodic call keeps it alive and sizes it to the widest
 *   viewer. The viewer's ack is paced (one every 100 ms at most) and held back while a viewer's
 *   connection is backed up, so a slow phone gets fewer frames, not a growing queue.
 * - The task's lease is re-checked while anyone watches: a task that lost its machine ends the
 *   view.
 * - Takeover is the user's own action on their own browser. It is refused for an unattended run
 *   (nobody is there to take over, and nobody to hand back); watching is not.
 * - Input is rate limited, validated against the contract, and accepted only while the user is in
 *   control. It is the user's own action: it is not classified or approved, and it is not logged.
 */

import { z } from "zod";
import {
	MAX_INPUT_EVENTS,
	inputEventSchema,
	type BrowserRuntime,
	type InputEvent,
} from "./contract";
import type { TaskControl, TaskController } from "./takeover";
import { subscribeBrowserFrames } from "$lib/server/code/machines";
import { decodeBrowserFramePayload } from "$lib/types/machineProtocol";

/**
 * What a live stream is of, and where it runs: every session payload carries it, so any surface
 * can say "Chat task on Laptop, shop.example.com" without asking again. `kind` is generic: a
 * chat's browse task, a tab the user lent to a chat, or (when wired) an agent machine's browser.
 */
export type LiveKind = "browse_task" | "lent_tab" | "agent_machine";
export interface LiveSessionInfo {
	id: string;
	machineId: string;
	machineName: string;
	kind: LiveKind;
	/** The page's address without query or fragment (they can carry tokens); null before a page. */
	url: string | null;
	origin: string | null;
	controller: TaskController;
	/** A scheduled run: watchable, not takeable. */
	unattended: boolean;
	/** A browser the user opened themselves (no agent): input from the start, nothing to hand back. */
	userOwned: boolean;
}

export type LiveEvent =
	| { type: "session"; info: LiveSessionInfo }
	| { type: "frame"; seq: number; width: number; height: number; jpeg: Buffer }
	| { type: "control"; controller: TaskController }
	| { type: "end"; reason: "ended" | "lease_lost" };

export interface LiveViewer {
	/** Sends one event; false when the viewer's connection is backed up (the frame is dropped). */
	send(event: LiveEvent): boolean;
	/** The width, in pixels, this viewer can show. */
	width: number;
}

export type LiveRuntime = Pick<BrowserRuntime, "control"> & {
	screencast?: (
		request:
			{ action: "start"; width?: number } | { action: "stop" } | { action: "ack"; seq: number },
		signal?: AbortSignal
	) => Promise<unknown>;
	input?: (events: InputEvent[], signal?: AbortSignal) => Promise<unknown>;
};

export interface LiveTaskInit {
	/** The browse tool call's uuid: what the card knows the task by. */
	taskId: string;
	userId: string;
	deviceId: string;
	/** The machine's display name. */
	machineName: string;
	kind?: LiveKind;
	runtime: LiveRuntime;
	control: TaskControl;
	/** A scheduled run: nobody to take over. */
	unattended?: boolean;
	/** The user's own browser session on a machine, opened on request (`userSession.ts`). */
	userOwned?: boolean;
	/** Still the holder of the machine's browser? */
	leaseHeld?: () => Promise<boolean>;
	/** Called once when the stream ends (the task ended, or the lease was lost). */
	onEnd?: () => void;
	/** Test seams. */
	subscribeFrames?: typeof subscribeBrowserFrames;
	timing?: Partial<typeof TIMING>;
}

const TIMING = {
	/** One ack at most this often. */
	ackEveryMs: 100,
	/** An ack waits this long when a viewer's connection is backed up. */
	backedUpMs: 500,
	/** The screencast is asked to stay alive this often (the runtime stops it after 25 s of quiet). */
	keepAliveMs: 8_000,
	leaseEveryMs: 10_000,
};
const MAX_WIDTH = 1600;
const MIN_WIDTH = 160;

/** Input limits: calls and events a second, per task. */
const CALLS_PER_SECOND = 40;
const EVENTS_PER_SECOND = 600;

export const inputBodySchema = z.object({
	events: z.array(inputEventSchema).min(1).max(MAX_INPUT_EVENTS),
});

export type LiveRefusal = { ok: false; status: 400 | 403 | 409 | 429 | 501 | 502; message: string };
export type LiveOk<T = object> = { ok: true } & T;

const registry = new Map<string, LiveTask>();

/** The running task `taskId`, only for its owner. */
export function liveTaskFor(taskId: string, userId: string): LiveTask | undefined {
	const task = registry.get(taskId);
	return task && task.userId === userId ? task : undefined;
}

/** Registers a running task for live viewing. The returned function ends it (call it when the task ends). */
export function registerLiveTask(init: LiveTaskInit): () => void {
	const task = new LiveTask(init);
	registry.set(init.taskId, task);
	return () => {
		if (registry.get(init.taskId) === task) registry.delete(init.taskId);
		void task.end("ended");
	};
}

export class LiveTask {
	readonly taskId: string;
	readonly userId: string;
	readonly deviceId: string;
	readonly unattended: boolean;
	private readonly init: LiveTaskInit;
	private readonly timing: typeof TIMING;
	private readonly viewers = new Set<LiveViewer>();
	private unsubscribeFrames?: () => void;
	private unsubscribeControl?: () => void;
	private keepAlive?: NodeJS.Timeout;
	private leaseTimer?: NodeJS.Timeout;
	private ackTimer?: NodeJS.Timeout;
	private pendingAck = 0;
	private lastAckAt = 0;
	private backedUp = false;
	private castWidth = 0;
	private ended = false;
	private kind: LiveKind;
	private url: string | null = null;
	private bucket = { at: 0, calls: 0, events: 0 };

	constructor(init: LiveTaskInit) {
		this.init = init;
		this.taskId = init.taskId;
		this.userId = init.userId;
		this.deviceId = init.deviceId;
		this.unattended = init.unattended === true;
		this.kind = init.kind ?? "browse_task";
		this.timing = { ...TIMING, ...init.timing };
	}

	/** Where the stream runs and what it is of, for any surface. */
	info(): LiveSessionInfo {
		let origin: string | null = null;
		try {
			origin = this.url ? new URL(this.url).origin : null;
		} catch {
			origin = null;
		}
		return {
			id: this.taskId,
			machineId: this.deviceId,
			machineName: this.init.machineName,
			kind: this.kind,
			url: this.url,
			origin,
			controller: this.controller,
			unattended: this.unattended,
			userOwned: this.init.userOwned === true,
		};
	}

	/** The page the browser is on changed (or it became a lent tab): viewers are told. */
	setPage(url: string, lent: boolean): void {
		let plain: string;
		try {
			const u = new URL(url);
			plain = `${u.origin}${u.pathname}`;
		} catch {
			return;
		}
		const kind: LiveKind =
			this.kind === "agent_machine" ? this.kind : lent ? "lent_tab" : "browse_task";
		if (plain === this.url && kind === this.kind) return;
		this.url = plain;
		this.kind = kind;
		this.broadcast({ type: "session", info: this.info() });
	}

	get controller(): TaskController {
		return this.init.control.controller;
	}

	/** Whether this task's machine can stream and take input at all (an older runtime cannot). */
	get supported(): boolean {
		return typeof this.init.runtime.screencast === "function";
	}

	get viewerCount(): number {
		return this.viewers.size;
	}

	// ---- viewers ---------------------------------------------------------------------------

	/** Adds a viewer; the first one starts the stream. The returned function removes it. */
	addViewer(viewer: LiveViewer): () => void {
		if (this.ended) {
			viewer.send({ type: "end", reason: "ended" });
			return () => {};
		}
		this.viewers.add(viewer);
		viewer.send({ type: "session", info: this.info() });
		viewer.send({ type: "control", controller: this.controller });
		if (this.viewers.size === 1) this.startStream();
		else void this.sizeStream();
		return () => this.removeViewer(viewer);
	}

	setWidth(viewer: LiveViewer, width: number): void {
		viewer.width = width;
		void this.sizeStream();
	}

	private removeViewer(viewer: LiveViewer): void {
		if (!this.viewers.delete(viewer)) return;
		if (this.viewers.size === 0) void this.stopStream();
		else void this.sizeStream();
	}

	private wantedWidth(): number {
		const widest = Math.max(0, ...[...this.viewers].map((v) => v.width));
		return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widest || 640)));
	}

	private startStream(): void {
		const subscribe = this.init.subscribeFrames ?? subscribeBrowserFrames;
		this.unsubscribeFrames = subscribe(this.deviceId, (seq, payload) => this.onFrame(seq, payload));
		this.unsubscribeControl = this.init.control.onChange((controller) => {
			this.broadcast({ type: "control", controller });
		});
		this.keepAlive = setInterval(() => void this.sizeStream(true), this.timing.keepAliveMs);
		this.keepAlive.unref?.();
		this.leaseTimer = setInterval(() => void this.checkLease(), this.timing.leaseEveryMs);
		this.leaseTimer.unref?.();
		this.castWidth = 0;
		void this.sizeStream(true);
	}

	/** Tells the machine the width to cast at (also its keepalive), when it changed or `force`d. */
	private async sizeStream(force = false): Promise<void> {
		const screencast = this.init.runtime.screencast;
		if (!screencast || this.ended || this.viewers.size === 0) return;
		const width = this.wantedWidth();
		if (!force && width === this.castWidth) return;
		this.castWidth = width;
		try {
			await screencast.call(this.init.runtime, { action: "start", width });
		} catch {
			// The machine did not take it; the next keepalive tries again.
		}
	}

	private async stopStream(): Promise<void> {
		this.unsubscribeFrames?.();
		this.unsubscribeControl?.();
		this.unsubscribeFrames = this.unsubscribeControl = undefined;
		clearInterval(this.keepAlive);
		clearInterval(this.leaseTimer);
		clearTimeout(this.ackTimer);
		this.keepAlive = this.leaseTimer = this.ackTimer = undefined;
		this.pendingAck = 0;
		this.castWidth = 0;
		try {
			await this.init.runtime.screencast?.({ action: "stop" });
		} catch {
			// Stopped by its own timeout in a moment.
		}
	}

	private async checkLease(): Promise<void> {
		if (this.ended || !this.init.leaseHeld) return;
		if (!(await this.init.leaseHeld().catch(() => false))) await this.end("lease_lost");
	}

	/** The task ended or lost its machine: every viewer is told, and the stream stops. */
	async end(reason: "ended" | "lease_lost"): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		registry.delete(this.taskId);
		this.init.onEnd?.();
		const viewers = [...this.viewers];
		this.viewers.clear();
		for (const viewer of viewers) viewer.send({ type: "end", reason });
		if (viewers.length > 0 || this.unsubscribeFrames) await this.stopStream();
	}

	// ---- frames ----------------------------------------------------------------------------

	private onFrame(seq: number, payload: Buffer): void {
		const frame = decodeBrowserFramePayload(payload);
		if (!frame || this.ended) return;
		let all = true;
		for (const viewer of this.viewers) {
			if (
				!viewer.send({
					type: "frame",
					seq,
					width: frame.width,
					height: frame.height,
					jpeg: frame.jpeg,
				})
			) {
				all = false;
			}
		}
		this.backedUp = !all;
		this.pendingAck = Math.max(this.pendingAck, seq);
		this.scheduleAck();
	}

	private broadcast(event: LiveEvent): void {
		for (const viewer of this.viewers) viewer.send(event);
	}

	/** One ack at a time, at most every `ackEveryMs`, later while a viewer is backed up. */
	private scheduleAck(): void {
		if (this.ackTimer || this.pendingAck === 0) return;
		const wait = Math.max(
			this.backedUp ? this.timing.backedUpMs : 0,
			this.lastAckAt + this.timing.ackEveryMs - Date.now(),
			0
		);
		this.ackTimer = setTimeout(() => {
			this.ackTimer = undefined;
			const seq = this.pendingAck;
			this.pendingAck = 0;
			this.lastAckAt = Date.now();
			void this.init.runtime.screencast?.({ action: "ack", seq }).catch(() => undefined);
		}, wait);
		this.ackTimer.unref?.();
	}

	// ---- takeover and input ----------------------------------------------------------------

	async takeover(): Promise<LiveOk<{ controller: TaskController }> | LiveRefusal> {
		if (this.init.userOwned) return { ok: true, controller: this.controller };
		if (this.unattended) {
			return {
				ok: false,
				status: 403,
				message: "A scheduled run has nobody to hand the browser back to: it cannot be taken over.",
			};
		}
		if (!this.init.control.supported) {
			return {
				ok: false,
				status: 501,
				message: "The browser on that computer is too old for takeover. Update galopin there.",
			};
		}
		try {
			await this.init.control.takeover();
		} catch {
			return { ok: false, status: 502, message: "The browser on that computer did not answer." };
		}
		return { ok: true, controller: this.controller };
	}

	async handBack(): Promise<LiveOk<{ controller: TaskController }> | LiveRefusal> {
		if (this.init.userOwned) {
			return { ok: false, status: 409, message: "This browser is yours: close it instead." };
		}
		if (!this.init.control.supported) {
			return { ok: false, status: 501, message: "This runtime cannot hand control over." };
		}
		try {
			await this.init.control.handBack();
		} catch {
			return { ok: false, status: 502, message: "The browser on that computer did not answer." };
		}
		return { ok: true, controller: this.controller };
	}

	/** The user's events to the page. Only while the user is in control; rate limited. */
	async input(body: unknown): Promise<LiveOk<{ sent: number }> | LiveRefusal> {
		const parsed = inputBodySchema.safeParse(body);
		if (!parsed.success) {
			return { ok: false, status: 400, message: "That is not a list of input events." };
		}
		if (!this.init.control.paused()) {
			return {
				ok: false,
				status: 409,
				message: "Take over first: input is accepted only while you are in control.",
			};
		}
		if (!this.init.runtime.input) {
			return {
				ok: false,
				status: 501,
				message: "The browser on that computer is too old for takeover.",
			};
		}
		const now = Date.now();
		if (now - this.bucket.at >= 1_000) this.bucket = { at: now, calls: 0, events: 0 };
		this.bucket.calls += 1;
		this.bucket.events += parsed.data.events.length;
		if (this.bucket.calls > CALLS_PER_SECOND || this.bucket.events > EVENTS_PER_SECOND) {
			return { ok: false, status: 429, message: "Too much input at once." };
		}
		try {
			await this.init.runtime.input(parsed.data.events);
		} catch {
			return {
				ok: false,
				status: 502,
				message: "The browser on that computer did not take the input.",
			};
		}
		return { ok: true, sent: parsed.data.events.length };
	}
}
