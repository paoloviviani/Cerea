/**
 * Who has the browser page, from the Cerea server's side (ADR 0116 phase 2a).
 *
 * The runtime on the machine is the source of truth: while the user is in control it refuses every
 * agent tool ("paused") and takes the user's input. This mirrors that state for the loop (which
 * waits on it, `PauseGate` in `loop.ts`) and for the live view (which shows it and sends the
 * hand-back). The user takes control from Cerea's live view (`takeover()`) or in the headed
 * window's banner, which only the runtime sees: the loop then learns from the runtime's
 * "paused" answer (`runtimePaused()`), and the hand-back clicked in the window is found by
 * polling the runtime's state while the loop waits.
 */

import type { BrowserRuntime, ControlResult } from "./contract";
import type { PauseGate } from "./loop";

export type TaskController = "agent" | "user";

export class TaskControl implements PauseGate {
	private user = false;
	private source: "cerea" | "banner" | undefined;
	private readonly wake = new Set<() => void>();
	private readonly listeners = new Set<(controller: TaskController) => void>();

	constructor(
		private readonly runtime: Pick<BrowserRuntime, "control">,
		private readonly options: { pollMs?: number } = {}
	) {}

	/** Whether the runtime can hand control over at all (an older one cannot). */
	get supported(): boolean {
		return typeof this.runtime.control === "function";
	}

	get controller(): TaskController {
		return this.user ? "user" : "agent";
	}

	paused(): boolean {
		return this.user;
	}

	onChange(listener: (controller: TaskController) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private set(user: boolean, source?: "cerea" | "banner"): void {
		if (this.user === user) return;
		this.user = user;
		this.source = user ? source : undefined;
		for (const fn of [...this.wake]) fn();
		for (const fn of [...this.listeners]) fn(this.controller);
	}

	/** The user takes control from the live view. The runtime pauses first; only then is it so. */
	async takeover(signal?: AbortSignal): Promise<ControlResult> {
		if (!this.runtime.control) throw new Error("This runtime cannot hand control over.");
		const state = await this.runtime.control("takeover", signal);
		if (state.controller === "user") this.set(true, state.source ?? "cerea");
		return state;
	}

	/** The user hands the page back: the agent continues from a fresh look at it. */
	async handBack(signal?: AbortSignal): Promise<ControlResult> {
		if (!this.runtime.control) throw new Error("This runtime cannot hand control over.");
		const state = await this.runtime.control("handback", signal);
		if (state.controller === "agent") this.set(false);
		return state;
	}

	/** The runtime answered "paused" to the agent: the user took control in the window. */
	runtimePaused(): void {
		this.set(true, "banner");
	}

	/**
	 * Resolves when the agent has the page again. While it waits it asks the runtime now and then,
	 * so a hand-back clicked in the window is found too. A runtime that cannot be asked does not
	 * end the wait: the user's hand-back (or the task's end) does.
	 */
	async waitForHandBack(signal?: AbortSignal): Promise<void> {
		const pollMs = this.options.pollMs ?? 2_000;
		while (this.user && !signal?.aborted) {
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					this.wake.delete(done);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, pollMs);
				this.wake.add(done);
				signal?.addEventListener("abort", done, { once: true });
			});
			if (!this.user || signal?.aborted) break;
			try {
				const state = await this.runtime.control?.("state", signal);
				if (state?.controller === "agent") this.set(false);
			} catch {
				// Unanswered now: asked again at the next round.
			}
		}
	}

	/** Where the control came from, for the live view. */
	get by(): "cerea" | "banner" | undefined {
		return this.source;
	}
}
