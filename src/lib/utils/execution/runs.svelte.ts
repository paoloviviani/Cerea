import { untrack } from "svelte";
import { withAttachmentMounts } from "./attachmentMounts.svelte";
import { getExecutionSession, type ExecutionSession, type ExecutionStatus } from "./runtime";
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
	/**
	 * Files the runtime held when this run settled — the run's outputs, for
	 * download. Memory-only, never persisted here: the worker filesystem dies
	 * with the page load, so a listing from a previous load would name files
	 * that no longer exist. (Every run's files are separately uploaded to the
	 * server-side output store once it settles — `uploadRunFiles`, called by
	 * CodeExecutionCard, CodeBlock and the artifact panel — but that is a
	 * parallel path, not something RunsStore itself does.)
	 */
	outputFiles?: Array<{ path: string; size: number }>;
	/**
	 * Set once the async file listing for a settled run has finished (even
	 * when it found nothing). The outcome settles synchronously for fence
	 * consumers, but the `execute_code` tool's one-shot outcome POST must
	 * wait for this flag — otherwise it posts before `outputFiles` lands,
	 * wins the server-side CAS with `files: []`, and the later upload's
	 * `fileRefs` are dropped as a duplicate (orphaning the stored bytes).
	 */
	outputsCollected?: boolean;
	/**
	 * Deliverables persisted server-side, rendered instead of `outputFiles` on
	 * true replay (no live run holds the bytes). Set only by a replay fallback
	 * (CodeExecutionCard's resolved state, CodeBlock's stored files), never by
	 * a live run. `sha256` travels when the source reference carries it — the
	 * inline file artifact card joins the registry by it.
	 */
	persistedFiles?: Array<{ name: string; size: number; sha256?: string; downloadUrl: string }>;
	startedAt: number;
	finishedAt?: number;
}

class RunsStore {
	#runs = $state<Record<string, RunState>>({});
	#runtimeStatus = $state<ExecutionStatus>("unloaded");
	#listening = false;
	/**
	 * Fence run keys a `CodeBlock` has actually watched go from streaming to
	 * settled — i.e. genuinely "streamed in", as opposed to loaded from
	 * history already closed. Kept here (module-scoped, not component
	 * `$state`) because the block that watches a given fence is not always
	 * the same instance for its whole life: the containing message's each-key
	 * swaps at settle (`stream-${index}` → `block.id`, see
	 * MarkdownRenderer.svelte), which remounts `CodeBlock` right at the
	 * moment auto-run needs to fire. A fresh instance still finds its own
	 * runKey marked here, so auto-run survives the remount instead of never
	 * firing.
	 */
	#seenStreaming = new Set<string>();

	get status(): ExecutionStatus {
		return this.#runtimeStatus;
	}

	get(key: string): RunState | undefined {
		return this.#runs[key];
	}

	/** Record that `key`'s fence was observed while its message was still streaming. */
	markSeenStreaming(key: string): void {
		this.#seenStreaming.add(key);
	}

	/** Whether `key` was ever seen streaming in this tab (never true for a history block). */
	hasSeenStreaming(key: string): boolean {
		return this.#seenStreaming.has(key);
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

		withAttachmentMounts(() => session.run(code))
			.then((outcome) => {
				const settled: RunState = {
					...state,
					status: outcome.ok ? "done" : "error",
					outcome,
					finishedAt: Date.now(),
				};
				// Written synchronously: the outcome must land in the same
				// microtask it always did. The file listing follows when it
				// arrives and amends the same entry — outputs, not outcome.
				// `outputsCollected` always flips (even when empty; the listing
				// never rejects), so a waiter on the flag can never hang.
				this.#runs[key] = settled;
				void collectOutputFiles(session).then((outputFiles) => {
					this.#runs[key] = { ...settled, outputFiles: outputFiles ?? [], outputsCollected: true };
				});
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
					// No files to wait for on a sandbox-level failure.
					outputsCollected: true,
				};
			});

		return this.#runs[key];
	}
}

let store: RunsStore | undefined;

/**
 * What the runtime holds after a run, for the output-files panel. A listing
 * that fails is an empty panel, never a failed run — the outcome already
 * settled, and files are a convenience on top of it.
 */
export async function collectOutputFiles(
	session: ExecutionSession
): Promise<Array<{ path: string; size: number }> | undefined> {
	try {
		const files = await session.listFiles();
		return files.length > 0 ? files : undefined;
	} catch {
		return undefined;
	}
}

/** Browser-only; undefined during SSR where no code can run. */
export function getRunsStore(): RunsStore | undefined {
	if (typeof window === "undefined") return undefined;
	store ??= new RunsStore();
	return store;
}
