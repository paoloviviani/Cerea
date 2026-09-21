<!--
	One coding session: its transcript and its changes, side by side as tabs.

	The tabs are local state, not the address — the address names the agent
	(`?device=&ws=&agent=`), and everything under it is this agent's. The
	`{#key}` in `CodePanel` remounts this whole view on a new address, so both
	tabs fetch in `onMount` and never see a stale agent.

	Phase 3 adds the composer and the blocking `PermissionCard` here, under
	the transcript: this is where a follow-up is written and where a waiting
	approval blocks.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import IconCode from "~icons/carbon/code";
	import AgentTimeline from "./AgentTimeline.svelte";
	import AgentDiff from "./AgentDiff.svelte";
	import { getAgent } from "$lib/codeApi";
	import type { CodeAgentSession } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		agentId: string;
	}

	let { agentId }: Props = $props();

	type Tab = "transcript" | "changes";
	let tab = $state<Tab>("transcript");
	let agent = $state<CodeAgentSession | null>(null);

	onMount(() => {
		(async () => {
			try {
				agent = (await getAgent(agentId)).agent;
			} catch {
				// The transcript and diff carry their own states; a header
				// that only errors when the daemon is off is worse than a
				// fallback title.
				agent = null;
			}
		})();
	});

	function stateTone(state: CodeAgentSession["state"]): s.PillTone {
		if (state === "running" || state === "waiting-permission") return "busy";
		if (state === "error") return "bad";
		if (state === "done") return "good";
		return "neutral";
	}
</script>

<div class="{s.EMBEDDED} flex min-h-0 flex-1 flex-col">
	<div class="border-b border-line px-4 pt-4">
		<div class="flex items-center gap-2 pb-3">
			<IconCode class="size-4 shrink-0 text-ink-muted" />
			<h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
				{agent?.title ?? "Agent"}
			</h2>
			{#if agent}
				<span class="{s.PILL} {s.PILL_TONES.neutral}">{agent.provider}</span>
				<span class="{s.PILL} {s.PILL_TONES[stateTone(agent.state)]}">{agent.state}</span>
			{/if}
		</div>
		<nav aria-label="Agent views" class="flex gap-1">
			{#each [{ key: "transcript", label: "Transcript" }, { key: "changes", label: "Changes" }] as t (t.key)}
				{@const active = tab === t.key}
				<button
					onclick={() => (tab = t.key as Tab)}
					aria-current={active ? "page" : undefined}
					class="rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors {active
						? 'border-blue-600 text-blue-700 dark:text-blue-400'
						: 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
				>
					{t.label}
				</button>
			{/each}
		</nav>
	</div>

	<div class="flex min-h-0 flex-1 flex-col p-4">
		{#if tab === "transcript"}
			<AgentTimeline {agentId} />
		{:else}
			<AgentDiff {agentId} />
		{/if}
	</div>
</div>
