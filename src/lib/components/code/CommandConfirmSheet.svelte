<!--
	The confirmation sheet behind the / menu's backend commands: the first
	run of a project-origin or shell-expanding command per (device, name,
	templateHash) asks here, with the exact facts the machine's listing
	carried — the shell snippets it would expand and the files it reads —
	and never the template itself. Accepting remembers the hash in
	localStorage per device; a changed template answers 409 upstream and
	this sheet opens again ("review again"). A UI speed bump by design: the
	machine's commandShell policy is the real veto.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconCode from "~icons/carbon/code";
	import IconWarning from "~icons/carbon/warning-filled";
	import LucideTerminal from "~icons/lucide/terminal";
	import * as s from "$lib/components/overlay/styles";
	import type { CodeCommand } from "$lib/types/CodeAgent";

	interface Props {
		command: CodeCommand;
		onconfirm: () => Promise<void>;
		onclose: () => void;
	}

	let { command, onconfirm, onclose }: Props = $props();

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let confirmButtonEl = $state<HTMLButtonElement | undefined>();

	async function confirm() {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await onconfirm();
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "The daemon refused.";
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		setTimeout(() => {
			confirmButtonEl?.focus();
		}, 100);
	});
</script>

<Modal width="max-w-md" closeButton labelledBy="command-confirm-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
				{#if command.shell}
					<LucideTerminal class="size-5 text-blue-600 dark:text-blue-400" />
				{:else}
					<IconCode class="size-5 text-blue-600 dark:text-blue-400" />
				{/if}
			</div>
			<div class="min-w-0 flex-1">
				<h2 id="command-confirm-title" class={s.TITLE}>Run /{command.name}?</h2>
				<p class={s.SUBTITLE}>
					{command.origin === "project" ? "From this repository." : "Defined on this machine."}
				</p>
			</div>
		</div>

		<div class="flex flex-col gap-3">
			<p class="text-sm text-gray-700 dark:text-gray-300">
				This command runs on your machine. Running a project command is running repository code.
			</p>

			{#if command.shellSnippets?.length}
				<div>
					<div
						class="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400"
					>
						<LucideTerminal class="size-3.5" />
						Shell it would run
					</div>
					<ul class="flex flex-col gap-1">
						{#each command.shellSnippets as snippet (snippet)}
							<li>
								<code
									class="block rounded-lg bg-gray-100 px-2.5 py-1.5 font-mono text-xs break-all text-gray-800 dark:bg-gray-800 dark:text-gray-200"
								>
									{snippet}
								</code>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if command.fileRefs?.length}
				<div>
					<div
						class="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400"
					>
						<IconWarning class="size-3.5" />
						Files it reads
					</div>
					<ul class="flex flex-col gap-1">
						{#each command.fileRefs as ref (ref)}
							<li>
								<code
									class="block rounded-lg bg-gray-100 px-2.5 py-1.5 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200"
								>
									@{ref}
								</code>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if failure}
				<p class="text-sm text-danger">{failure}</p>
			{/if}
		</div>

		<div class="sticky mt-6 flex justify-end gap-2">
			<button class="btn rounded-lg px-3 py-1.5 text-sm" type="button" onclick={onclose}>
				Cancel
			</button>
			<button
				bind:this={confirmButtonEl}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
				type="button"
				disabled={busy}
				onclick={() => void confirm()}
			>
				{busy ? "Running…" : `Run /${command.name}`}
			</button>
		</div>
	</div>
</Modal>
