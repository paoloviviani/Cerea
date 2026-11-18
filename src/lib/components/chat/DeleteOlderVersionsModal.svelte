<!--
	Confirm "Delete older versions" (C122): says how many versions go, that it cannot be
	undone, and that the current version and any version with an active share link stay.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Modal from "$lib/components/Modal.svelte";

	interface Props {
		/** How many older versions the panel can see; shown as the number that go. */
		count: number;
		busy?: boolean;
		onclose?: () => void;
		onconfirm?: () => void;
	}

	let { count, busy = false, onclose, onconfirm }: Props = $props();
</script>

<Modal {onclose} width="w-[90dvh] md:w-[480px]">
	<div class="flex w-full flex-col gap-5 p-6" data-testid="delete-older-modal">
		<h2 class="text-xl font-semibold text-gray-800 dark:text-gray-200">
			{m["chat.panel.delete_older_title"]()}
		</h2>
		<p class="text-sm text-gray-600 dark:text-gray-400">
			{m["chat.panel.delete_older_body"]({ count })}
		</p>
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				class="inline-flex items-center rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-900 shadow-sm outline-hidden hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
				onclick={onclose}
			>
				{m["app.cancel"]()}
			</button>
			<button
				type="button"
				disabled={busy}
				data-testid="delete-older-confirm"
				class="inline-flex items-center rounded-xl border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-600"
				onclick={onconfirm}
			>
				{m["chat.panel.delete_older_confirm"]()}
			</button>
		</div>
	</div>
</Modal>
