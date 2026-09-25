<!--
	The composer's model pill, in the style of Claude's: one popover that
	switches the model for this chat and, for a model that thinks, how hard.

	- A search field, then a short list: the current model and the ones the
	  person picked recently (at most six), each with its one-line
	  description and a check on the current one.
	- "Effort ▸": the model's effort levels plus Default, only for a model
	  that takes one (a preset that pins effort shows it, read-only).
	- "More models ▸": the full searchable picker.

	Callbacks, not writes: the chat and /code wire picks differently (a
	conversation PATCH or the new-chat default here; machine ops there).
-->
<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import CarbonCaretDown from "~icons/carbon/caret-down";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import LucideCheck from "~icons/lucide/check";
	import { effortLabel, shortList, type PickerModel } from "$lib/utils/modelEffortPicker";

	interface Props {
		models: PickerModel[];
		currentId: string;
		recentIds: string[];
		/** The levels this model takes, or null when it takes none. */
		efforts: string[] | null;
		/** The effort in force; undefined = Default. */
		effort?: string;
		/** A preset pins the effort: shown, not changeable. */
		effortPinned?: boolean;
		onpickModel: (id: string) => void;
		onpickEffort: (effort: string | undefined) => void;
		onmore: () => void;
		/** The pill's own content (model name, logo, badges). */
		children: Snippet;
		disabled?: boolean;
		/** The trigger's own class list — chat's underline-text pill by
		 * default; /code passes its composer's own pill classes so the
		 * control reads like the mode and feature pills beside it. */
		triggerClass?: string;
		/** Rendered inside the menu, after the model rows and before the
		 * effort/"More models" section: the /code-only notes (a
		 * machine-policy veto, "N non-gateway models hidden…") that have no
		 * home in the shared list itself. Chat renders nothing here. */
		footer?: Snippet;
	}

	let {
		models,
		currentId,
		recentIds,
		efforts,
		effort,
		effortPinned = false,
		onpickModel,
		onpickEffort,
		onmore,
		children,
		disabled = false,
		triggerClass = "inline-flex min-w-0 items-center gap-1 hover:underline disabled:no-underline",
		footer,
	}: Props = $props();

	let open = $state(false);
	let query = $state("");
	let rows = $derived(shortList(models, currentId, recentIds, query));

	function pick(id: string) {
		open = false;
		query = "";
		if (id !== currentId) onpickModel(id);
	}
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger class={triggerClass} aria-label="Model and effort" {disabled}>
		{@render children()}
		{#if efforts}
			<span class="shrink-0 text-gray-500 dark:text-gray-400">· {effortLabel(effort)}</span>
		{/if}
		<CarbonCaretDown class="-ml-0.5 shrink-0 text-xxs" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 w-72 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
			side="top"
			align="start"
			sideOffset={6}
		>
			<div class="p-1">
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="h-8 w-full rounded-md border border-gray-200 bg-transparent px-2 text-sm outline-hidden focus:border-gray-400 dark:border-gray-600"
					placeholder="Search models"
					aria-label="Search models"
					autofocus
					bind:value={query}
					onkeydown={(e) => {
						// The menu's typeahead would otherwise eat the keystrokes.
						e.stopPropagation();
						if (e.key === "Enter" && rows[0]) pick(rows[0].id);
					}}
				/>
			</div>
			{#each rows as row (row.id)}
				<DropdownMenu.Item
					class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
					onSelect={() => pick(row.id)}
				>
					<span class="min-w-0 flex-1">
						<span class="block truncate">{row.name}</span>
						{#if row.description}
							<span class="block truncate text-xs text-gray-500 dark:text-gray-400"
								>{row.description}</span
							>
						{/if}
					</span>
					{#if row.id === currentId}
						<LucideCheck class="mt-0.5 size-4 shrink-0 text-gray-500" />
					{/if}
				</DropdownMenu.Item>
			{:else}
				<p class="px-2 py-1.5 text-xs text-gray-500">No model matches.</p>
			{/each}
			{@render footer?.()}
			<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700" />
			{#if efforts}
				{#if effortPinned}
					<div class="flex h-8 items-center justify-between px-2 text-sm text-gray-500">
						<span>Effort</span><span>{effortLabel(effort)} · set by this mode</span>
					</div>
				{:else}
					<DropdownMenu.Sub>
						<DropdownMenu.SubTrigger
							class="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
						>
							<span>Effort</span>
							<span class="flex items-center gap-1 text-gray-500 dark:text-gray-400">
								{effortLabel(effort)}
								<CarbonChevronRight class="size-3" />
							</span>
						</DropdownMenu.SubTrigger>
						<DropdownMenu.SubContent
							class="z-50 min-w-36 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
							sideOffset={4}
						>
							{#each [undefined, ...efforts] as level (level ?? "default")}
								<DropdownMenu.Item
									class="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
									onSelect={() => onpickEffort(level)}
								>
									<span>{effortLabel(level)}</span>
									{#if effort === level}
										<LucideCheck class="size-4 text-gray-500" />
									{/if}
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.SubContent>
					</DropdownMenu.Sub>
				{/if}
			{/if}
			<DropdownMenu.Item
				class="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
				onSelect={() => {
					open = false;
					onmore();
				}}
			>
				<span>More models</span>
				<CarbonChevronRight class="size-3 text-gray-500" />
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
