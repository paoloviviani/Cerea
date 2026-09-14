import { untrack } from "svelte";
import { getExecutionSession, type ExecutionStatus } from "./runtime";
import type { RunOutcome } from "./protocol";

/**
 * Reactive record of code executions, keyed by the caller's identity for the
 * snippet (chat block content hash, artifact version key). The runtime itself
 * is a single lazy worker shared by every surface — chat blocks and artifact
 * cells take turns on the same interpreter.
 *
 * Chat outputs are session-scoped on purpose: an assistant block that
 * auto-ran while streaming keeps its output for the session, and a block
 * revisited from history shows a Run affordance instead of silently
 * re-executing code on every page load. Artifact cells persist their outputs
 * (see artifactRuns.ts).
 */

export type RunStatus = "loading" | "queued" | "running" | "done" | "error";

export interface RunState {
	status: RunStatus;
	outcome?: RunOutcome;
	/** Sandbox-level failure (load failure, timeout, terminated) */
	sandboxError?: string;
	startedAt: number;
	finishedAt?: number;
}

function hashCode(code: string): string {
	let hash = 5381;
	for (let i = 0; i < code.length; i++) {
		hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/** Stable key for a chat code block: identical code in one session runs once. */
export function chatRunKey(code: string): string {
	return `chat:${hashCode(code)}`;
}

class RunsStore {
	#runs = $state<Record<string, RunState>>({});
	#runtimeStatus = $state<ExecutionStatus>("unloaded");
	#listening = false;

	get status(): ExecutionStatus {
		return this.#runtimeStatus;
	}

	get(key: string): RunState | undefined {
		return this.#runs[key];
	}

	/**
	 * Run `code` under `key`. Idempotent per key while a run is pending or
	 * finished: re-renders never re-execute code. `force` (the explicit Run
	 * button) replaces the previous state and runs again.
	 */
	run(key: string, code: string, options: { force?: boolean } = {}): RunState | undefined {
		const session = getExecutionSession();
		if (!session) return undefined;
		// Untracked: a caller that reads through run() (an effect) must not
		// subscribe to future state writes, or every settlement re-triggers it.
		const existing = untrack(() => this.#runs[key]);
		// Any existing entry settles the request: re-renders never re-execute
		// code, and a failed run is not silently retried — the explicit Run
		// button (`force`) is the only path to a second attempt.
		if (existing && !options.force) {
			return existing;
		}

		if (!this.#listening) {
			this.#listening = true;
			session.onStatus((status) => {
				this.#runtimeStatus = status;
			});
		}

		const state: RunState = {
			status: this.#runtimeStatus === "ready" ? "running" : "loading",
			startedAt: Date.now(),
		};
		this.#runs[key] = state;

		session
			.run(code)
			.then((outcome) => {
				this.#runs[key] = {
					...state,
					status: outcome.ok ? "done" : "error",
					outcome,
					finishedAt: Date.now(),
				};
			})
			.catch((error: unknown) => {
				this.#runs[key] = {
					...state,
					status: "error",
					sandboxError:
						error instanceof Error
							? error.message
							: "the execution sandbox could not run this code",
					finishedAt: Date.now(),
				};
			});

		return this.#runs[key];
	}
}

let store: RunsStore | undefined;

/** Browser-only; undefined during SSR where no code can run. */
export function getRunsStore(): RunsStore | undefined {
	if (typeof window === "undefined") return undefined;
	store ??= new RunsStore();
	return store;
}
