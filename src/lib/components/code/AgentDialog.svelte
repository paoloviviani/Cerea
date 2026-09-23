<!--
	A new coding session on one workspace of one paired device.

	The daemon decides what is possible: the provider list is fetched from
	it (never hardcoded here — the panel would drift from what the daemon
	can actually run), and creation is scoped to the workspace so the
	agent lands in the tree it was opened from. The first prompt is not
	asked here; the agent view's composer is that surface, so the person
	enrolls the device once and does everything else through Cerea.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconCode from "~icons/carbon/code";
	import IconWarning from "~icons/carbon/warning-filled";
	import { createAgent, listProviders } from "$lib/codeApi";
	import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		workspace: CodeWorkspace;
		onclose: () => void;
		oncreated: (agent: CodeAgentSession) => void;
	}

	let { deviceId, workspace, onclose, oncreated }: Props = $props();

	let providers = $state<Array<{ id: string; available: boolean }>>([]);
	let provider = $state("");
	let posture = $state<"plan" | "write">("plan");
	let title = $state("");
	let busy = $state(true);
	let failure = $state<string | null>(null);

	onMount(async () => {
		try {
			const result = await listProviders(deviceId);
			providers = result.providers.filter((p) => p.available);
			provider = providers[0]?.id ?? "opencode";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not read the daemon's providers.";
		} finally {
			busy = false;
		}
	});

	async function handleCreate() {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			const created = await createAgent(deviceId, {
				cwd: workspace.path,
				provider,
				posture,
				...(title.trim() ? { title: title.trim() } : {}),
				workspaceId: workspace.id,
			});
			oncreated(created.agent);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not create the agent.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="agent-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconCode class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="agent-title" class={s.TITLE}>New agent</h2>
				<p class={s.SUBTITLE}>In {workspace.name} — {workspace.path}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Agent failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				void handleCreate();
			}}
		>
			<label class={s.LABEL} for="agent-provider">Provider</label>
			{#if busy && providers.length === 0}
				<p class="text-sm text-ink-muted">Reading the daemon's providers…</p>
			{:else}
				<select
					id="agent-provider"
					class={s.INPUT}
					bind:value={provider}
					disabled={busy || providers.length === 0}
				>
					{#if providers.length === 0}
						<option value="opencode">opencode</option>
					{/if}
					{#each providers as p (p.id)}
						<option value={p.id}>{p.id}</option>
					{/each}
				</select>
				<p class={s.HINT}>
					{providers.length > 0
						? "As configured on your daemon."
						: "No providers reported available; opencode is the default."}
				</p>
			{/if}

			<label class="{s.LABEL} mt-4" for="agent-title-input">Title (optional)</label>
			<input
				id="agent-title-input"
				class={s.INPUT}
				placeholder="Refactor the login flow"
				maxlength={120}
				bind:value={title}
				disabled={busy}
			/>

			<span class="{s.LABEL} mt-4">Posture</span>
			<div class="flex gap-2">
				<button
					type="button"
					class={posture === "plan" ? s.PRIMARY : s.SECONDARY}
					onclick={() => (posture = "plan")}
					disabled={busy}
				>
					Plan
				</button>
				<button
					type="button"
					class={posture === "write" ? s.PRIMARY : s.SECONDARY}
					onclick={() => (posture = "write")}
					disabled={busy}
				>
					Write
				</button>
			</div>
			<p class={s.HINT}>
				{posture === "plan"
					? "Proposes; asks before it writes anything."
					: "Writes; still asks before anything destructive."}
			</p>

			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy}>
					{busy ? "Creating…" : "Create agent"}
				</button>
			</div>
		</form>
	</div>
</Modal>
