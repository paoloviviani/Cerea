<!--
	Follow-ups the machine is holding until the agent's running turn ends (hello capability
	`queue`: a backend without steering, like Mistral Vibe or goose, sends a message sent
	mid-turn when the turn is over instead of folding it in). They sit above the composer,
	oldest first, each with a cancel: the transcript shows a message only once it has been
	sent, so this is the one place a waiting message is visible.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import IconClock from "~icons/carbon/time";
	import IconClose from "~icons/carbon/close";

	interface Props {
		queued: Array<{ id: string; text: string; files?: number }>;
		/** Withdraws one; the list itself comes back on the stream. */
		oncancel: (id: string) => void;
	}

	let { queued, oncancel }: Props = $props();
</script>

{#if queued.length > 0}
	<ul
		class="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5 px-1"
		data-testid="queued-messages"
		aria-label={m["code.queued.label"]()}
	>
		{#each queued as item (item.id)}
			<li
				class="flex items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
				data-testid="queued-message"
			>
				<IconClock class="size-3.5 flex-none" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
				<span class="flex-none text-xs">{m["code.queued.waiting"]()}</span>
				<button
					type="button"
					class="flex-none rounded-full p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
					aria-label={m["code.queued.cancel"]()}
					title={m["code.queued.cancel"]()}
					onclick={() => oncancel(item.id)}
				>
					<IconClose class="size-3.5" />
				</button>
			</li>
		{/each}
	</ul>
{/if}
