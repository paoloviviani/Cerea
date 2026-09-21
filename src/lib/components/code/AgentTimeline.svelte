<!--
	The live transcript of one coding session, from the agent update stream.

	Mounting this iterator IS the history fetch: a fresh subscription starts
	at `fromSeq=0` and the bridge replays the daemon's log before tailing, so
	no separate snapshot call exists and reload is lossless. Partials merge
	into the open message; tool, plan and permission frames upsert by id, so a
	replayed log converges on the same transcript as a live one.

	A waiting approval renders as the blocking `PermissionCard` inline — the
	agent holds until it is answered, so the card sits where the hold
	happened rather than in a separate approvals tray.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import IconTool from "~icons/carbon/tool-kit";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconPending from "~icons/carbon/pending-filled";
	import IconDocument from "~icons/carbon/document";
	import IconRenew from "~icons/carbon/renew";
	import PermissionCard from "./PermissionCard.svelte";
	import {
		CodeAgentUpdateType,
		type CodeAgentUpdate,
		type CodePermissionRequestUpdate,
		type CodePlanUpdate,
		type CodeToolCallUpdate,
	} from "$lib/types/CodeAgent";
	import { codeAgentStream } from "$lib/codeAgentStream";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
	}

	let { deviceId, agentId }: Props = $props();

	type Entry =
		| { kind: "message"; role: "agent" | "user"; text: string; open: boolean }
		| { kind: "tool"; update: CodeToolCallUpdate }
		| { kind: "plan"; update: CodePlanUpdate }
		| { kind: "permission"; update: CodePermissionRequestUpdate }
		| { kind: "turn"; state: string; detail?: string }
		| { kind: "diff"; count: number };

	let entries = $state<Entry[]>([]);
	let streaming = $state(true);
	let failure = $state<string | null>(null);
	let scrollEl: HTMLDivElement | undefined = $state();

	function scrollDown() {
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
	}

	function applyUpdate(update: CodeAgentUpdate) {
		switch (update.type) {
			case CodeAgentUpdateType.AgentMessage: {
				const last = entries[entries.length - 1];
				if (update.partial) {
					if (last?.kind === "message" && last.role === update.role && last.open) {
						last.text += update.text;
					} else {
						entries.push({ kind: "message", role: update.role, text: update.text, open: true });
					}
				} else {
					if (last?.kind === "message" && last.role === update.role && last.open) {
						last.text += update.text;
						last.open = false;
					} else {
						entries.push({ kind: "message", role: update.role, text: update.text, open: false });
					}
				}
				break;
			}
			case CodeAgentUpdateType.ToolCall: {
				const at = entries.findIndex(
					(entry): entry is Extract<Entry, { kind: "tool" }> =>
						entry.kind === "tool" && entry.update.id === update.id
				);
				if (at >= 0) entries[at] = { kind: "tool", update };
				else entries.push({ kind: "tool", update });
				break;
			}
			case CodeAgentUpdateType.Plan: {
				const at = entries.findLastIndex((entry) => entry.kind === "plan");
				// A plan frame is a snapshot, not an event: it replaces the
				// previous one rather than appending to the transcript.
				if (at >= 0) entries[at] = { kind: "plan", update };
				else entries.push({ kind: "plan", update });
				break;
			}
			case CodeAgentUpdateType.TurnState: {
				entries.push({ kind: "turn", state: update.state, detail: update.detail });
				break;
			}
			case CodeAgentUpdateType.PermissionRequest: {
				const at = entries.findIndex(
					(entry): entry is Extract<Entry, { kind: "permission" }> =>
						entry.kind === "permission" && entry.update.requestId === update.requestId
				);
				if (at >= 0) entries[at] = { kind: "permission", update };
				else entries.push({ kind: "permission", update });
				break;
			}
			case CodeAgentUpdateType.Diff: {
				entries.push({ kind: "diff", count: update.files.length });
				break;
			}
		}
		scrollDown();
	}

	onMount(() => {
		const abort = new AbortController();
		(async () => {
			try {
				for await (const update of codeAgentStream(deviceId, agentId, abort.signal)) {
					applyUpdate(update);
				}
			} catch (err) {
				if (!abort.signal.aborted) {
					failure = err instanceof Error ? err.message : "The agent stream failed.";
				}
			} finally {
				streaming = false;
			}
		})();
		return () => abort.abort();
	});

	function toolTone(status: CodeToolCallUpdate["status"]): { tone: s.PillTone; label: string } {
		if (status === "done") return { tone: "good", label: "done" };
		if (status === "error") return { tone: "bad", label: "error" };
		return { tone: "busy", label: "running" };
	}
</script>

<div
	bind:this={scrollEl}
	class="scrollbar-custom flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
>
	{#if entries.length === 0 && !failure}
		<div class={s.EMPTY}>
			{#if streaming}
				<IconRenew class="{s.EMPTY_ICON} animate-spin" />
				<p class={s.EMPTY_TITLE}>Connecting to the agent…</p>
				<p class={s.EMPTY_DETAIL}>Replaying its transcript, then following live.</p>
			{:else}
				<IconPending class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>No transcript yet</p>
				<p class={s.EMPTY_DETAIL}>This agent has not produced any updates.</p>
			{/if}
		</div>
	{/if}

	{#if failure}
		<div class={s.ERROR}>{failure}</div>
	{/if}

	{#each entries as entry, i (i)}
		{#if entry.kind === "message"}
			<div
				class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {entry.role === 'user'
					? 'self-end bg-accent-subtle text-ink'
					: 'bg-sunken text-ink'}"
			>
				{entry.text}
			</div>
		{:else if entry.kind === "tool"}
			{@const { tone, label } = toolTone(entry.update.status)}
			<div class="{s.card(false)} {s.CARD_BODY}">
				<div class="flex items-center gap-2 text-sm">
					<IconTool class="size-4 shrink-0 text-ink-muted" />
					<span class="min-w-0 flex-1 truncate font-mono text-xs">{entry.update.tool}</span>
					<span class="{s.PILL} {s.PILL_TONES[tone]}">{label}</span>
				</div>
				{#if entry.update.output}
					<details class="mt-2">
						<summary class="cursor-pointer text-xs text-ink-muted">Output</summary>
						<pre
							class="mt-1 scrollbar-custom max-h-48 overflow-auto rounded bg-sunken p-2 font-mono text-xs whitespace-pre-wrap text-ink">{entry
								.update.output}</pre>
					</details>
				{/if}
			</div>
		{:else if entry.kind === "plan"}
			<div class="{s.card(true)} {s.CARD_BODY}">
				<p class="text-sm font-semibold text-ink">{entry.update.goal}</p>
				<ul class="mt-2 space-y-1">
					{#each entry.update.steps as step (step.title)}
						<li class="flex items-center gap-2 text-sm text-ink-muted">
							{#if step.status === "done"}
								<IconCheckmark class="size-4 shrink-0 text-green-700" />
							{:else if step.status === "active"}
								<IconPending class="size-4 shrink-0 text-blue-700" />
							{:else}
								<span class="size-4 shrink-0 rounded-full border border-line-strong"></span>
							{/if}
							<span class={step.status === "done" ? "line-through" : ""}>{step.title}</span>
						</li>
					{/each}
				</ul>
			</div>
		{:else if entry.kind === "turn"}
			<p class="text-center text-xs text-ink-faint">
				{entry.state}{entry.detail ? ` — ${entry.detail}` : ""}
			</p>
		{:else if entry.kind === "permission"}
			<PermissionCard {deviceId} {agentId} request={entry.update} />
		{:else if entry.kind === "diff"}
			<p class="text-center text-xs text-ink-faint">
				<IconDocument class="mr-1 inline size-3" />
				{entry.count}
				{entry.count === 1 ? "file" : "files"} changed — see Changes
			</p>
		{/if}
	{/each}

	{#if streaming && entries.length > 0}
		<p class="flex items-center gap-1.5 text-xs text-ink-faint">
			<IconRenew class="size-3 animate-spin" />
			Following live
		</p>
	{/if}
</div>
