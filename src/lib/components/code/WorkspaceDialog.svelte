<!--
	A workspace backed by a directory the person can see on their machine.

	One step, not two: the daemon serves whatever directory it is given, so
	the person types the absolute path (a checkout, e.g. ~/Pystino) and an
	optional title. The server refuses relative paths — they would resolve
	against whatever cwd the daemon process was born with, unguessable from
	here — and the daemon refuses paths it cannot serve. Either refusal
	arrives as the failure below, never as a row that pretends.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import IconFolder from "~icons/carbon/folder";
	import IconWarning from "~icons/carbon/warning-filled";
	import { createWorkspace } from "$lib/codeApi";
	import type { CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		onclose: () => void;
		oncreated: (workspace: CodeWorkspace) => void;
	}

	let { deviceId, onclose, oncreated }: Props = $props();

	let path = $state("");
	let title = $state("");
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function handleCreate() {
		if (!path.trim() || busy) return;
		busy = true;
		failure = null;
		try {
			const created = await createWorkspace(deviceId, {
				path: path.trim(),
				...(title.trim() ? { title: title.trim() } : {}),
			});
			oncreated(created.workspace);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not create the workspace.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="workspace-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconFolder class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="workspace-title" class={s.TITLE}>Add a workspace</h2>
				<p class={s.SUBTITLE}>A directory on this machine the daemon serves agents from.</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Workspace failed
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
			<label class={s.LABEL} for="workspace-path">Directory on the machine</label>
			<input
				id="workspace-path"
				class={s.INPUT}
				placeholder="/home/you/checkouts/myrepo"
				maxlength={1024}
				bind:value={path}
				disabled={busy}
			/>
			<p class={s.HINT}>Absolute path, as the daemon sees it — not this browser.</p>
			<label class="{s.LABEL} mt-4" for="workspace-name">Title (optional)</label>
			<input
				id="workspace-name"
				class={s.INPUT}
				placeholder="myrepo"
				maxlength={120}
				bind:value={title}
				disabled={busy}
			/>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !path.trim()}>
					{busy ? "Adding…" : "Add workspace"}
				</button>
			</div>
		</form>
	</div>
</Modal>
