<script lang="ts">
	import { base } from "$app/paths";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonChip from "~icons/carbon/chip";
	import BlockWrapper from "./BlockWrapper.svelte";
	import RunOutput from "./RunOutput.svelte";
	import { getRunsStore } from "$lib/utils/execution/runs.svelte";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import type { MessageCodeExecutionRequestUpdate } from "$lib/types/MessageUpdate";
	import type { MessageCodeExecutionResolvedUpdate } from "$lib/types/MessageUpdate";
	import type { RunState } from "$lib/utils/execution/runs.svelte";

	/**
	 * The browser side of the `execute_code` tool: the parked code runs in the
	 * person's own ExecutionSession through the SAME RunsStore path a fence Run
	 * uses, so the outcome and the files the run created surface through the
	 * existing RunOutput → FileCard rendering untouched. When the run settles,
	 * the outcome is posted back to the resolve endpoint once — which records it
	 * on the parked row and wakes the turn via the sweep. If the tab is gone
	 * before the run settles, nothing is posted and the sweeper's deadline turns
	 * the parked row into the "environment unavailable" fallback.
	 */
	interface Props {
		conversationId: string;
		request: MessageCodeExecutionRequestUpdate;
		/** Set on replay from the persisted update (outcome WITHOUT files). */
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

	// Post the outcome back exactly once per mounted card once the run settles.
	// A re-mounted card (navigation) may re-post; the endpoint's CAS answers 409
	// and the duplicate is silently dropped.
	let posted = false;
	$effect(() => {
		const state = runState;
		if (resolved || posted || !state) return;
		if (state.status !== "done" && state.status !== "error") return;
		posted = true;
		const outcome = state.outcome;
		if (!outcome) return;
		void fetch(`${base}/conversation/${conversationId}/code-execution`, {
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
				},
			}),
		}).catch(() => {
			// Nothing is waiting on the POST response: the sweeper's deadline is
			// the backstop, and a failed POST means the turn falls back the same
			// way an absent browser would.
		});
	});

	/** Replay: the persisted outcome WITHOUT files — no dead download cards. */
	let resolvedRunState = $derived.by((): RunState | undefined => {
		if (!resolved) return undefined;
		const outcome = resolved.outcome;
		return {
			status: outcome.ok ? "done" : "error",
			outcome,
			startedAt: 0,
			finishedAt: 0,
		};
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
			<RunOutput state={resolved ? resolvedRunState : runState} />
		</div>
	</div>
</BlockWrapper>
