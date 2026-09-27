<script lang="ts">
	import type { SlashCommand, SlashCommandGroup } from "$lib/utils/slashCommand.svelte";

	interface Props {
		results: SlashCommand[];
		activeIndex: number;
		/**
		 * Where the `/` sits, relative to the composer box — the same anchor
		 * the hub mention panel uses, so the menu reads as an autocomplete for
		 * that word and floats above the composer (clear of the mobile
		 * send/stop overlay, which sits at its bottom edge).
		 */
		caretAnchor: { left: number; bottom: number };
		onselect: (command: SlashCommand) => void;
		onactivechange: (index: number) => void;
	}

	let { results, activeIndex, caretAnchor, onselect, onactivechange }: Props = $props();
	let listboxElement: HTMLDivElement | undefined = $state();

	const labels: Record<SlashCommandGroup, string> = {
		panel: "Panel",
		project: "Project",
		machine: "Machine",
		skill: "Skills",
		mcp: "MCP",
	};

	/**
	 * Group once, carrying each option's flat index with it — the same
	 * single-pass grouping the hub listbox does, so arrow-key navigation
	 * stays O(1) per row.
	 */
	let groups = $derived(
		(["panel", "project", "machine", "skill", "mcp"] as SlashCommandGroup[])
			.map((group) => ({
				group,
				options: results
					.map((result, index) => ({ result, index }))
					.filter((option) => option.result.group === group),
			}))
			.filter((entry) => entry.options.length > 0)
	);

	$effect(() => {
		void activeIndex;
		listboxElement
			?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	});
</script>

<!-- The live region is a sibling of the listbox, not a child — the same
     rule the hub panel's notes: a listbox may only own options and groups. -->
<div class="sr-only" role="status" aria-live="polite">
	{#if results.length === 0}
		No matching commands
	{:else}
		{results.length} commands available
	{/if}
</div>

<div
	class="pointer-events-none absolute z-30"
	style="left: {caretAnchor.left}px; bottom: {caretAnchor.bottom}px;"
>
	<div
		bind:this={listboxElement}
		id="slash-command-listbox"
		role="listbox"
		aria-label="Slash commands"
		class="pointer-events-auto scrollbar-custom max-h-64 w-72 max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-[13px] shadow-lg dark:border-gray-700 dark:bg-gray-900"
	>
		{#if results.length === 0}
			<p class="px-2.5 py-1.5 text-gray-400 dark:text-gray-500">No matching commands</p>
		{:else}
			{#each groups as entry (entry.group)}
				<div role="group" aria-label={labels[entry.group]}>
					<div
						data-command-header={entry.group}
						class="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wide text-gray-400 uppercase dark:text-gray-500"
					>
						{labels[entry.group]}
					</div>
					{#each entry.options as option (option.result.name)}
						<button
							id={`slash-command-option-${option.index}`}
							data-result-index={option.index}
							data-command-name={option.result.name}
							type="button"
							role="option"
							aria-selected={option.index === activeIndex}
							class={[
								"flex w-full items-center gap-2 px-2.5 py-1 text-left focus:outline-hidden",
								option.index === activeIndex
									? "bg-gray-100 dark:bg-gray-800"
									: "hover:bg-gray-50 dark:hover:bg-gray-800/60",
							]}
							onpointerdown={(event) => event.preventDefault()}
							onmouseenter={() => onactivechange(option.index)}
							onclick={() => onselect(option.result)}
						>
							<span class="font-mono text-gray-800 dark:text-gray-200">
								/{option.result.name}
							</span>
							<span class="min-w-0 flex-1 truncate text-right text-gray-500 dark:text-gray-400">
								{option.result.description}
							</span>
						</button>
					{/each}
				</div>
			{/each}
		{/if}
	</div>
</div>
