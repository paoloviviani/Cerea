<script lang="ts">
	import { base } from "$app/paths";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonChip from "~icons/carbon/chip";
	import BlockWrapper from "./BlockWrapper.svelte";
	import RunOutput from "./RunOutput.svelte";
	import { getRunsStore } from "$lib/utils/execution/runs.svelte";
	import { getExecutionSession } from "$lib/utils/execution/runtime";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import type { MessageCodeExecutionRequestUpdate } from "$lib/types/MessageUpdate";
	import type { MessageCodeExecutionResolvedUpdate } from "$lib/types/MessageUpdate";
	import type { RunState } from "$lib/utils/execution/runs.svelte";
	import type { RunOutcome } from "$lib/utils/execution/protocol";
	import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";

	/**
	 * The browser side of the `execute_code` tool: the parked code runs in the
	 * person's own ExecutionSession through the SAME RunsStore path a fence Run
	 * uses, so the outcome and the files the run created surface through the
	 * existing RunOutput → FileCard rendering untouched. When the run settles,
	 * its own output files (its deliverables) are uploaded to the persisted
	 * output store, and the outcome — with those references — is posted to the
	 * resolve endpoint once; that records it on the parked row and wakes the
	 * turn via the sweep. If the tab is gone before the run settles, nothing is
	 * posted and the sweeper's deadline turns the parked row into the
	 * "environment unavailable" fallback.
	 */
	interface Props {
		conversationId: string;
		request: MessageCodeExecutionRequestUpdate;
		/** Set on replay from the persisted update (sandbox paths dropped; `files` carries the durable references). */
		resolved?: MessageCodeExecutionResolvedUpdate;
	}

	let { conversationId, request, resolved }: Props = $props();

	let runsStore = getRunsStore();
	let runKey = $derived(runsStore ? chatRunKey(request.code) : "");
	let runState = $derived(runsStore && runKey ? runsStore.get(runKey) : undefined);

	// Kick the run exactly once per mounted card: the RunsStore dedups by key,
	// so a fence autorun of the same code settles this card too.
	let kicked = false;
	$effect(() => {
		if (resolved || !runsStore || !runKey || kicked) return;
		kicked = true;
		runsStore.run(runKey, request.code);
	});

	/**
	 * Upload the run's own output files to the persisted deliverable store
	 * (30-day TTL, per-user — see `$lib/server/execution/deliverables.ts`)
	 * before the outcome is posted. A tool run's `outputFiles` ARE its
	 * deliverables (the conservative rule the server module documents); a
	 * file the runtime can no longer read (removed mid-run) is skipped rather
	 * than failing the whole upload, since the live outcome still reports it.
	 */
	async function uploadDeliverables(
		files: Array<{ path: string; size: number }>
	): Promise<PersistedDeliverableRef[]> {
		if (files.length === 0) return [];
		const session = getExecutionSession();
		if (!session) return [];

		const form = new FormData();
		let any = false;
		for (const f of files) {
			try {
				const data = await session.readFile(f.path);
				form.append("file", new Blob([data]), f.path.split("/").pop() || f.path);
				any = true;
			} catch {
				// Gone from the runtime already; the live outcome still names it.
			}
		}
		if (!any) return [];

		try {
			const res = await fetch(`${base}/conversation/${conversationId}/code-execution/output`, {
				method: "POST",
				body: form,
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { files: PersistedDeliverableRef[] };
			return body.files ?? [];
		} catch {
			return [];
		}
	}

	// Post the outcome back exactly once per mounted card once the run settles.
	// A re-mounted card (navigation) may re-post; the endpoint's CAS answers 409
	// and the duplicate is silently dropped.
	//
	// A sandbox-level failure (worker load error, run timeout, forced restart)
	// settles the RunsStore entry into `sandboxError` rather than `outcome` —
	// see runs.svelte.ts. Without turning that into an outcome too, this
	// effect had nothing to post, so a genuine load error (the worker's own
	// `loadError` message) sat unposted until the sweeper's deadline collapsed
	// it into the generic "browser did not answer" fallback, indistinguishable
	// from a tab that was simply backgrounded. Posting it as a failed outcome
	// keeps the actual reason in the model's tool result.
	let posted = false;
	$effect(() => {
		const state = runState;
		if (resolved || posted || !state) return;
		if (state.status !== "done" && state.status !== "error") return;
		const outcome: RunOutcome | undefined =
			state.outcome ??
			(state.sandboxError
				? { ok: false, stdout: "", stderr: "", error: state.sandboxError }
				: undefined);
		if (!outcome) return;
		posted = true;
		void (async () => {
			const fileRefs = await uploadDeliverables(state.outputFiles ?? []);
			await fetch(`${base}/conversation/${conversationId}/code-execution`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					executionId: request.executionId,
					outcome: {
						ok: outcome.ok,
						stdout: outcome.stdout,
						stderr: outcome.stderr,
						...(outcome.result ? { result: outcome.result } : {}),
						...(outcome.error ? { error: outcome.error } : {}),
						files: state.outputFiles ?? [],
						...(fileRefs.length ? { fileRefs } : {}),
					},
				}),
			}).catch(() => {
				// Nothing is waiting on the POST response: the sweeper's deadline is
				// the backstop, and a failed POST means the turn falls back the same
				// way an absent browser would.
			});
		})();
	});

	/**
	 * Replay: the persisted outcome, with sandbox paths dropped (dead on
	 * replay — no live worker holds them) and, when the browser uploaded them,
	 * `persistedFiles` built from the durable references so a download card
	 * still renders, reading its bytes from the server instead of a sandbox.
	 */
	let resolvedRunState = $derived.by((): RunState | undefined => {
		if (!resolved) return undefined;
		const outcome = resolved.outcome;
		return {
			status: outcome.ok ? "done" : "error",
			outcome,
			startedAt: 0,
			finishedAt: 0,
			persistedFiles: resolved.files?.map((f) => ({
				name: f.name,
				size: f.size,
				downloadUrl: `${base}/conversation/${conversationId}/code-execution/output/${f.sha256}`,
			})),
		};
	});

	/**
	 * Which state RunOutput draws. Prefer the live run whenever this session
	 * still holds it settled: its RunsStore entry carries `outputFiles` whose
	 * bytes are still in the worker, which previews faster than a server round
	 * trip and works even if the upload above is still in flight or failed.
	 * The persisted `resolved` update streams back seconds after the run —
	 * still the same session — so switching to it on arrival would swap a
	 * working card for one that depends on the upload having landed. Fall
	 * back to the resolved state (its `persistedFiles`, if any) only on true
	 * replay, when a fresh page load has left the RunsStore with no run for
	 * this code.
	 */
	let displayState = $derived.by((): RunState | undefined => {
		if (runState && (runState.status === "done" || runState.status === "error")) {
			return runState;
		}
		return resolved ? resolvedRunState : runState;
	});
</script>

<BlockWrapper>
	<div
		class="rounded-lg border border-blue-200/70 bg-blue-50/30 dark:border-blue-800/60 dark:bg-blue-950/20"
	>
		<div
			class="flex items-center gap-1.5 border-b border-blue-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-blue-800/60 dark:text-gray-400"
		>
			{#if resolved}
				<span>Assistant-run code</span>
			{:else if runState && (runState.status === "loading" || runState.status === "running" || runState.status === "queued")}
				<EosIconsLoading class="text-gray-400" />
				<span>{runState.status === "loading" ? "Starting Python" : "Running in your browser"}</span>
			{:else}
				<CarbonChip class="text-gray-400" />
				<span>Assistant-run code</span>
			{/if}
		</div>
		<div class="px-3 py-2">
			<RunOutput state={displayState} />
		</div>
	</div>
</BlockWrapper>
