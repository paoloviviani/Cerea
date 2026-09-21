<!--
	One waiting approval, answered here and now.

	Built in the spirit of the MCP elicitation card — a blocking approval the
	agent holds on — but standalone: this answers the daemon's permission
	endpoint, not chat elicitation, and carries no countdown (the request
	waits until answered, like a 2026-era prompt). While pending the card is
	the transcript's loudest element; once answered it collapses to the
	resolution, and the stream's own resolved frame converges on the same
	state when it arrives.
-->
<script lang="ts">
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconClose from "~icons/carbon/close";
	import { respondPermission, type PermissionDecision } from "$lib/codeApi";
	import type { CodePermissionRequestUpdate } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		request: CodePermissionRequestUpdate;
	}

	let { deviceId, agentId, request }: Props = $props();

	let busy = $state<PermissionDecision | null>(null);
	let failure = $state<string | null>(null);
	// Answered from here, ahead of the stream's resolved frame — which upserts
	// the same entry when it arrives, so optimism never diverges.
	let localResolution = $state<PermissionDecision | null>(null);

	const resolved = $derived(localResolution ?? request.resolution ?? null);
	const pending = $derived(request.pending && resolved === null);

	async function answer(decision: PermissionDecision) {
		if (busy || !pending) return;
		busy = decision;
		failure = null;
		try {
			await respondPermission(deviceId, agentId, request.requestId, decision);
			localResolution = decision;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not answer the request.";
		} finally {
			busy = null;
		}
	}
</script>

<div class="{s.card(pending)} {s.CARD_BODY}">
	<div class="flex items-center gap-2 text-sm font-medium text-ink">
		{#if pending}
			<IconWarning class="size-4 shrink-0 text-amber-700" />
			Approval needed — the agent is waiting
		{:else}
			<IconCheckmark class="size-4 shrink-0 text-ink-muted" />
			{resolved === "approved" ? "Approved" : "Denied"}
		{/if}
	</div>
	<p class="mt-1 text-sm text-ink-muted">{request.description}</p>
	{#if request.command}
		<pre
			class="mt-2 scrollbar-custom overflow-auto rounded bg-sunken p-2 font-mono text-xs text-ink">{request.command}</pre>
	{/if}

	{#if failure}
		<div class="{s.ERROR} mt-2">{failure}</div>
	{/if}

	{#if pending}
		<div class="mt-3 flex justify-end gap-2">
			<button onclick={() => void answer("deny")} class={s.SECONDARY} disabled={busy !== null}>
				<IconClose class="size-4" />
				{busy === "deny" ? "Denying…" : "Deny"}
			</button>
			<button onclick={() => void answer("approve")} class={s.PRIMARY} disabled={busy !== null}>
				<IconCheckmark class="size-4" />
				{busy === "approve" ? "Approving…" : "Approve"}
			</button>
		</div>
	{/if}
</div>
