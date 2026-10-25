<!--
	A git worktree, cut from an existing workspace's repository.

	One step: branch name (required, becomes both the git branch and the new
	workspace's directory name under `<repo>.worktrees/`) and an optional base
	ref to branch from (defaults to the source workspace's current HEAD, same
	as a bare `git worktree add -b <branch> <path>`). The daemon runs the git
	command and registers the resulting directory as its own workspace; this
	dialog does not touch the filesystem itself.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Modal from "$lib/components/Modal.svelte";
	import IconCode from "~icons/carbon/code";
	import IconWarning from "~icons/carbon/warning-filled";
	import { createWorkspace } from "$lib/codeApi";
	import type { CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		workspace: CodeWorkspace;
		onclose: () => void;
		oncreated: (workspace: CodeWorkspace) => void;
	}

	let { deviceId, workspace, onclose, oncreated }: Props = $props();

	let branch = $state("");
	let base = $state("");
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function handleCreate() {
		if (!branch.trim() || busy) return;
		busy = true;
		failure = null;
		try {
			const created = await createWorkspace(deviceId, {
				worktree: {
					from: workspace.id,
					branch: branch.trim(),
					...(base.trim() ? { base: base.trim() } : {}),
				},
			});
			oncreated(created.workspace);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.worktree.could_not"]();
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="worktree-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class={s.STRIP_TILE}>
				<IconCode class="size-5 text-blue-600" />
			</div>
			<div>
				<h2 id="worktree-title" class={s.TITLE}>{m["code.worktree.title"]()}</h2>
				<p class={s.SUBTITLE}>{m["code.worktree.subtitle"]({ name: workspace.name })}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					{m["code.worktree.failed"]()}
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
			<label class={s.LABEL} for="worktree-branch">{m["code.worktree.branch"]()}</label>
			<input
				id="worktree-branch"
				class={s.INPUT}
				placeholder={m["code.worktree.branch_placeholder"]()}
				maxlength={200}
				bind:value={branch}
				disabled={busy}
			/>
			<p class={s.HINT}>{m["code.worktree.branch_hint"]()}</p>
			<label class="{s.LABEL} mt-4" for="worktree-base">{m["code.worktree.base"]()}</label>
			<input
				id="worktree-base"
				class={s.INPUT}
				placeholder={m["code.worktree.base_placeholder"]()}
				maxlength={200}
				bind:value={base}
				disabled={busy}
			/>
			<p class={s.HINT}>{m["code.worktree.base_hint"]({ name: workspace.name })}</p>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					{m["code.common.cancel"]()}
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !branch.trim()}>
					{busy ? m["code.worktree.creating"]() : m["code.worktree.create"]()}
				</button>
			</div>
		</form>
	</div>
</Modal>
