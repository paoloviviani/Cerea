/**
 * Watch and take over. Cerea's browser runtime drives the panel through the bridge; while the
 * user has taken over, every command from it is refused with a message the agent can act on,
 * and the user's own input is the only thing that moves the page. Handing back lets the runtime
 * go on; it looks at the page afresh before each action, and an approval is bound to the page
 * address and element as they were, so nothing approved earlier can run on a page that moved on.
 */
import type { Gate } from "./cdpBridge.ts";

export type Mode = "agent" | "user";

/** Commands that only wire up the connection, allowed while the user drives. */
const ALWAYS = new Set([
	"Runtime.runIfWaitingForDebugger",
	"Target.setDiscoverTargets",
	"Browser.getVersion",
	"Browser.getWindowForTarget",
	"Browser.setDownloadBehavior",
	"Target.getBrowserContexts",
	"Target.getTargets",
]);

export const TAKEN_OVER_MESSAGE =
	"The user has taken over the browser and is using it themselves. Do nothing until they hand it back.";

export class Control implements Gate {
	mode: Mode = "agent";
	private lastActivity = Number.NEGATIVE_INFINITY;
	private listeners = new Set<() => void>();

	constructor(private readonly now: () => number = Date.now) {}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	// Gate.mode
	current(): Mode {
		return this.mode;
	}

	set(mode: Mode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.emit();
	}

	/** The runtime sent something within the last 4 seconds. */
	get agentBusy(): boolean {
		return this.now() - this.lastActivity < 4000;
	}

	/** The runtime sent something within `ms` (a task between two steps counts as running). */
	recentlyActive(ms: number): boolean {
		return this.now() - this.lastActivity < ms;
	}

	/** A task is running: the runtime did something within the last 30 s (between steps it is quiet). */
	static readonly WORKING_MS = 30_000;
	get working(): boolean {
		return this.recentlyActive(Control.WORKING_MS);
	}

	private taskListeners = new Set<() => void>();
	private workingTimer?: NodeJS.Timeout;

	/** Called when the runtime starts on a task: its first sign after a quiet spell of 30 s or more. */
	onTaskStart(cb: () => void): () => void {
		this.taskListeners.add(cb);
		return () => this.taskListeners.delete(cb);
	}

	/** A sign of life that is not a command (the control stream connecting). */
	touch(): void {
		this.activity();
	}

	activity(): void {
		const was = this.agentBusy;
		const wasWorking = this.working;
		this.lastActivity = this.now();
		if (!wasWorking) for (const l of [...this.taskListeners]) l();
		if (!was || !wasWorking) this.emit();
		// One timer, moved on each sign of life: when it fires the task has been quiet for 30 s and the
		// "working" indicator goes. No polling.
		clearTimeout(this.workingTimer);
		this.workingTimer = setTimeout(() => this.emit(), Control.WORKING_MS + 50);
		this.workingTimer.unref();
	}

	/** Whether the browser panel is on screen: set by the app. Only then may a page bring itself to the front. */
	panelShowing: () => boolean = () => true;

	async pass(method: string): Promise<void> {
		if (method === "Page.bringToFront" && !this.panelShowing()) {
			throw new Error(
				"The browser panel is not showing, so a page cannot be brought to the front."
			);
		}
		if (this.mode === "user" && !ALWAYS.has(method)) throw new Error(TAKEN_OVER_MESSAGE);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}
