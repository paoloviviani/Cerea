<!--
	An agent rename, one field.

	The daemon's `updateAgent` name is the whole operation, so the tree
	redraws from the daemon's next listing — never from the string that was
	typed. An empty field submits nothing. Mirrors WorkspaceRenameDialog's
	shape (same Modal idiom, same busy/failure states) because the two
	dialogs are the same gesture on different rows.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import IconCode from "~icons/carbon/code";
	import IconWarning from "~icons/carbon/warning-filled";
	import { renameAgent } from "$lib/codeApi";
	import type { CodeAgentSession } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agent: CodeAgentSession;
		onclose: () => void;
		/** Fired only after the daemon answered; the caller redraws from it. */
		onrenamed: () => void;
	}

	let { deviceId, agent, onclose, onrenamed }: Props = $props();

	// The prefill is the name at open time, on purpose: the dialog mounts
	// fresh per open ({#if} above), so the initial value is the right one —
	// a rename that races a tree reload should not rewrite the field under
	// the person typing.
	// svelte-ignore state_referenced_locally
	let name = $state(agent.title);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function handleRename() {
		const next = name.trim();
		if (!next || busy) return;
		busy = true;
		failure = null;
		try {
			await renameAgent(deviceId, agent.id, next);
			onrenamed();
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not rename the session.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="agent-rename-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconCode class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="agent-rename-title" class={s.TITLE}>Rename session</h2>
				<p class={s.SUBTITLE}>{agent.title}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Rename failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				void handleRename();
			}}
		>
			<label class={s.LABEL} for="agent-rename-name">Name</label>
			<input
				id="agent-rename-name"
				class={s.INPUT}
				placeholder="debug session"
				maxlength={120}
				bind:value={name}
				disabled={busy}
			/>
			<p class={s.HINT}>Shown in the sidebar's agent list.</p>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !name.trim()}>
					{busy ? "Renaming…" : "Rename"}
				</button>
			</div>
		</form>
	</div>
</Modal>
