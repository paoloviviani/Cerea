<!--
	A workspace rename, one field.

	The daemon's `setWorkspaceTitle` is the whole operation — the title
	overrides the derived name in its listings — so the tree redraws from
	the daemon's answer (the title as the daemon recorded it), never from
	the string that was typed. An empty field submits nothing: a cleared
	name is the daemon's `null`, which this dialog does not offer, because
	un-naming a workspace is the daemon's business and the tree would only
	show the derived path again.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import IconFolder from "~icons/carbon/folder";
	import IconWarning from "~icons/carbon/warning-filled";
	import { renameWorkspace } from "$lib/codeApi";
	import type { CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		workspace: CodeWorkspace;
		onclose: () => void;
		/** Fired only after the daemon answered; the caller redraws from it. */
		onrenamed: () => void;
	}

	let { deviceId, workspace, onclose, onrenamed }: Props = $props();

	// The prefill is the name at open time, on purpose: the dialog mounts
	// fresh per open ({#if} above), so the initial value is the right one —
	// a rename that races a tree reload should not rewrite the field under
	// the person typing.
	// svelte-ignore state_referenced_locally
	let title = $state(workspace.name);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function handleRename() {
		const next = title.trim();
		if (!next || busy) return;
		busy = true;
		failure = null;
		try {
			await renameWorkspace(deviceId, workspace.id, next);
			onrenamed();
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not rename the workspace.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="workspace-rename-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconFolder class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="workspace-rename-title" class={s.TITLE}>Rename workspace</h2>
				<p class={s.SUBTITLE}>{workspace.path}</p>
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
			<label class={s.LABEL} for="workspace-rename-name">Title</label>
			<input
				id="workspace-rename-name"
				class={s.INPUT}
				placeholder="myrepo"
				maxlength={120}
				bind:value={title}
				disabled={busy}
			/>
			<p class={s.HINT}>Shown in the sidebar's workspace tree.</p>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !title.trim()}>
					{busy ? "Renaming…" : "Rename"}
				</button>
			</div>
		</form>
	</div>
</Modal>
