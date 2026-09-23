<!--
	Deliberate removals in the agents tree ask once, here. The dialog owns
	only the question and the failure: the caller's `onconfirm` does the
	work and resolves when the daemon has answered, so a refusal keeps the
	question on screen with the daemon's own words under it — the person
	decides again with the reason in view, the same failure-banner idiom as
	the creation dialogs. Nothing is optimistically removed here; the tree
	is redrawn from the daemon after the daemon says yes.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconTrash from "~icons/carbon/trash-can";
	import IconWarning from "~icons/carbon/warning-filled";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		title: string;
		/** The row the question is about, so "this" always names something. */
		target: string;
		/** What disappears and what does not, written for the person asked. */
		message: string;
		confirmLabel: string;
		busyLabel?: string;
		onconfirm: () => Promise<void>;
		onclose: () => void;
	}

	let { title, target, message, confirmLabel, busyLabel, onconfirm, onclose }: Props = $props();

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
		// The dangerous button takes focus, so Enter on an opened question
		// confirms it. Delayed like DeleteConversationModal does: the Modal
		// focuses its own surface on mount, after this component's children
		// mount, and would take the focus straight back.
		setTimeout(() => {
			confirmButtonEl?.focus();
		}, 100);
	});
</script>

<Modal width="max-w-md" closeButton labelledBy="code-confirm-title" {onclose}>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<!-- The tile shape is the strip tile's; the wash is the danger tone,
				because the question is not an accent-coloured one. -->
			<div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger/15">
				<IconTrash class="size-5 text-danger" />
			</div>
			<div>
				<h2 id="code-confirm-title" class={s.TITLE}>{title}</h2>
				<p class={s.SUBTITLE}>{target}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		<p class="text-sm text-ink-muted">{message}</p>

		<div class="mt-4 flex justify-end gap-2">
			<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}> Cancel </button>
			<!-- Destructive borrows the danger text tone rather than a red
				fill, per the palette's own convention (styles.ts). -->
			<button
				bind:this={confirmButtonEl}
				type="button"
				class="btn flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger-subtle px-3 py-1.5 text-sm font-medium text-danger hover:border-danger/50 disabled:opacity-50"
				disabled={busy}
				onclick={() => void confirm()}
			>
				{busy ? (busyLabel ?? confirmLabel) : confirmLabel}
			</button>
		</div>
	</div>
</Modal>
