<script lang="ts">
	import * as s from "$lib/components/overlay/styles";
	import { m } from "$lib/paraglide/messages";
	import CarbonClose from "~icons/carbon/close";
	import { getMountsStore } from "$lib/utils/execution/mounts.svelte";

	/**
	 * The inventory of files currently mounted into the execution runtime.
	 * The worker's filesystem is session-global — chat blocks and artifact
	 * cells share one interpreter — so this row is the only place that says
	 * what `/mnt/data` actually holds right now. Chat attachments left out of
	 * it (over a size cap, say) are listed too, so a missing file is explained.
	 */
	const mounts = getMountsStore();
</script>

{#if mounts?.files.length || mounts?.skipped.length}
	<div class="flex flex-wrap items-center gap-1.5 px-5 pb-1.5 text-xs">
		<span class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
			{m["chat.mounted.heading"]()}
		</span>
		{#each mounts.files as file (file.path)}
			<span class="{s.PILL} {s.PILL_TONES.neutral} font-mono">
				{file.path}
				<button
					type="button"
					class="btn rounded-full p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
					title={m["chat.mounted.stop"]({ path: file.path })}
					onclick={() => void mounts?.remove(file.path)}
				>
					<CarbonClose class="text-[10px]" />
				</button>
			</span>
		{/each}
		{#each mounts.skipped as note (note.name)}
			<span
				class="{s.PILL} {s.PILL_TONES.warn} font-mono"
				title={m["chat.mounted.unavailable_title"]({ name: note.name, reason: note.reason })}
			>
				{m["chat.mounted.unavailable"]({ name: note.name, reason: note.reason })}
			</span>
		{/each}
	</div>
{/if}
