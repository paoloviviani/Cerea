<script lang="ts">
	import CarbonClose from "~icons/carbon/close";
	import { getMountsStore } from "$lib/utils/execution/mounts.svelte";

	/**
	 * The inventory of files currently mounted into the execution runtime.
	 * The worker's filesystem is session-global — chat blocks and artifact
	 * cells share one interpreter — so this row is the only place that says
	 * what `/mnt/data` actually holds right now.
	 */
	const mounts = getMountsStore();
</script>

{#if mounts?.files.length}
	<div class="flex flex-wrap items-center gap-1.5 px-5 pb-1.5 text-xs">
		<span class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
			Mounted
		</span>
		{#each mounts.files as file (file.path)}
			<span
				class="flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-1 pl-2 font-mono text-gray-600 dark:bg-gray-800 dark:text-gray-300"
			>
				{file.path}
				<button
					type="button"
					class="btn rounded-full p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
					title="Remove {file.path} from the runtime"
					onclick={() => void mounts?.remove(file.path)}
				>
					<CarbonClose class="text-[10px]" />
				</button>
			</span>
		{/each}
	</div>
{/if}
