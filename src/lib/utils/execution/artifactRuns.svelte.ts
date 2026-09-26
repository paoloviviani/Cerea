import { untrack } from "svelte";
import { getExecutionSession } from "./runtime";
import { artifactRunKey } from "./keys";
import { collectOutputFiles } from "./runs.svelte";
import type { RunState } from "./runs.svelte";
import type { RunOutcome } from "./protocol";

/**
 * Execution outputs for artifact code cells, persisted with the artifact
 * version they belong to.
 *
 * Artifact versions are derived from message content — there is no server-side
 * artifact store to hang an output on — so the output lives in localStorage
 * under a key that binds it to exactly the code it was produced from
 * (`identifier:v{version}:{content hash}`). Navigating versions in the panel
 * shows each version its own output; an edit that lands on the same version
 * number still gets a fresh key, because the content hash differs.
 *
 * Chat block outputs are deliberately NOT persisted (see runs.svelte.ts);
 * artifact cells are the analysis surface, where re-opening an artifact and
 * finding its result is the point.
 */

export const ARTIFACT_RUNS_STORAGE_KEY = "cereas.artifactRuns.v1";

/** How many version outputs are kept; the oldest settled ones are evicted. */
export const MAX_PERSISTED_RUNS = 30;

interface StoredRun {
	outcome?: RunOutcome;
	sandboxError?: string;
	finishedAt: number;
}

function loadPersisted(): Record<string, StoredRun> {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(ARTIFACT_RUNS_STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, StoredRun>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		// Corrupted or unavailable storage: outputs are a convenience, not a
		// record of truth — start empty rather than refusing to run.
		return {};
	}
}

function persist(map: Record<string, StoredRun>): void {
	try {
		const entries = Object.entries(map);
		if (entries.length > MAX_PERSISTED_RUNS) {
			entries.sort((a, b) => a[1].finishedAt - b[1].finishedAt);
			for (const [key] of entries.slice(0, entries.length - MAX_PERSISTED_RUNS)) {
				delete map[key];
			}
		}
		localStorage.setItem(ARTIFACT_RUNS_STORAGE_KEY, JSON.stringify(map));
	} catch {
		// Quota or privacy mode: outputs stay in memory for the session.
	}
}

function fromStored(stored: StoredRun | undefined): RunState | undefined {
	if (!stored) return undefined;
	return {
		// A sandbox failure persisted without an outcome stays an error: the
		// code did not succeed, and a reload must not pretend otherwise.
		status: stored.outcome?.ok ? "done" : "error",
		outcome: stored.outcome,
		sandboxError: stored.sandboxError,
		startedAt: stored.finishedAt,
		finishedAt: stored.finishedAt,
	};
}

class ArtifactRunsStore {
	#persisted: Record<string, StoredRun> = loadPersisted();
	#memory = $state<Record<string, RunState>>({});

	get(key: string): RunState | undefined {
		return this.#memory[key] ?? fromStored(this.#persisted[key]);
	}

	/**
	 * Run the code of one artifact version. Idempotent per key (re-renders and
	 * version navigation never re-execute); `force` is the explicit Run button.
	 */
	run(
		identifier: string,
		version: number,
		content: string,
		options: { force?: boolean } = {}
	): RunState | undefined {
		const session = getExecutionSession();
		if (!session) return undefined;
		const key = artifactRunKey(identifier, version, content);
		// Untracked: a caller that reads through run() (an effect) must not
		// subscribe to future state writes, or every settlement re-triggers it.
		const existing = untrack(() => this.get(key));
		// Any existing entry settles the request; `force` is the Run button.
		if (existing && !options.force) return existing;

		const state: RunState = { status: "running", startedAt: Date.now() };
		untrack(() => {
			this.#memory[key] = state;
		});

		session
			.run(content)
			.then((outcome) => {
				const settled: RunState = {
					...state,
					status: outcome.ok ? "done" : "error",
					outcome,
					finishedAt: Date.now(),
				};
				// Settle (and persist) synchronously as before; the file
				// listing amends the memory entry when it lands and is never
				// persisted — the worker filesystem dies with the page load.
				this.settle(key, settled);
				// `outputsCollected` always flips (even when empty; the listing
				// never rejects) — the artifact panel's persist effect waits on it
				// exactly as the chat-block runs store does (runs.svelte.ts).
				void collectOutputFiles(session).then((outputFiles) => {
					this.#memory[key] = {
						...settled,
						outputFiles: outputFiles ?? [],
						outputsCollected: true,
					};
				});
			})
			.catch((error: unknown) => {
				this.settle(key, {
					...state,
					status: "error",
					sandboxError:
						error instanceof Error
							? error.message
							: "the execution sandbox could not run this code",
					finishedAt: Date.now(),
					// No files to wait for on a sandbox-level failure.
					outputsCollected: true,
				});
			});

		return this.#memory[key];
	}

	private settle(key: string, finalState: RunState): void {
		this.#memory[key] = finalState;
		// A settled run — success, python error, or sandbox kill — is the
		// version's output and persists as one; only an unsettled state would
		// be memory-only, and settle() is never called for those.
		this.#persisted[key] = {
			outcome: finalState.outcome,
			sandboxError: finalState.sandboxError,
			finishedAt: finalState.finishedAt ?? Date.now(),
		};
		persist(this.#persisted);
	}
}

let store: ArtifactRunsStore | undefined;

/** Browser-only; undefined during SSR where no code can run. */
export function getArtifactRunsStore(): ArtifactRunsStore | undefined {
	if (typeof window === "undefined") return undefined;
	store ??= new ArtifactRunsStore();
	return store;
}

export function clearArtifactRunsForTests(): void {
	store = undefined;
}
