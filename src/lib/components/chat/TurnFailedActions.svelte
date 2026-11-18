<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import CarbonRotate360 from "~icons/carbon/rotate-360";
	import CarbonPlay from "~icons/carbon/play-filled-alt";

	interface Props {
		/** Regenerate the turn from scratch: the failed attempt is left out of what the model sees. */
		onretry: () => void;
		/** Keep the partial output and ask the model to go on from it. Omitted when nothing was produced. */
		oncontinue?: () => void;
	}

	let { onretry, oncontinue }: Props = $props();

	const button =
		"btn inline-flex h-7 items-center gap-1 rounded-lg border bg-white px-2 py-1 text-sm text-gray-600 shadow-xs hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600";
</script>

<div class="mt-2 flex flex-wrap gap-2" data-exclude-from-copy>
	<button type="button" data-testid="turn-failed-retry" class={button} onclick={onretry}>
		<CarbonRotate360 class="text-[.65rem]" />
		{m["chat.turn_failed.retry"]()}
	</button>
	{#if oncontinue}
		<button type="button" data-testid="turn-failed-continue" class={button} onclick={oncontinue}>
			<CarbonPlay class="text-[.65rem]" />
			{m["chat.turn_failed.continue"]()}
		</button>
	{/if}
</div>
