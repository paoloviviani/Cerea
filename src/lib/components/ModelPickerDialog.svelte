<!--
	The full, searchable model list — "More models" from the model/effort
	pill (`ModelEffortPicker.svelte`). Presentational only: what a pick
	*means* (a conversation PATCH, a machine API call, a settings write)
	stays with the caller, passed in as `onchoose`. Chat and /code each wrap
	this with their own choose logic and their own title/subtitle/busy state;
	this component only searches, lists and reports the pick.
-->
<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import * as s from "$lib/components/overlay/styles";
	import type { PickerModel } from "$lib/utils/modelEffortPicker";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonSearch from "~icons/carbon/search";

	interface Props {
		models: PickerModel[];
		currentId: string;
		title: string;
		subtitle: string;
		/** The id of the model a pick is in flight for, else null. A row for
		 * this id shows "Switching" instead of its checkmark; every row is
		 * disabled while any pick is in flight. Callers that close the
		 * dialog on pick (no wait for confirmation) never need to set this. */
		busy?: string | null;
		onchoose: (id: string) => void;
		onclose: () => void;
	}

	let { models, currentId, title, subtitle, busy = null, onchoose, onclose }: Props = $props();

	let query = $state("");
	let searchEl = $state<HTMLInputElement>();

	// Focused on open, after `Modal`'s own onMount has put focus on the
	// dialog — a plain `autofocus` would lose that race, since effects run
	// after mounts.
	$effect(() => {
		searchEl?.focus();
	});

	const normalise = (value: string) => value.toLowerCase().trim();
	const tokens = $derived(normalise(query).split(/\s+/).filter(Boolean));

	const shown = $derived(
		models.filter((model) => {
			const haystack = normalise(
				`${model.id} ${model.name} ${model.baseName ?? ""} ${model.description ?? ""}`
			);
			return tokens.every((token) => haystack.includes(token));
		})
	);

	function choose(model: PickerModel) {
		if (model.id === currentId) {
			onclose();
			return;
		}
		onchoose(model.id);
	}
</script>

<Modal
	onclose={() => onclose()}
	width="w-[90dvw] md:{s.OVERLAY_PICKER}"
	labelledBy="model-picker-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="model-picker-title" class={s.TITLE}>{title}</h2>
			<p class={s.SUBTITLE}>{subtitle}</p>
		</div>

		<div class="relative mb-3">
			<CarbonSearch
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
			/>
			<input
				bind:this={searchEl}
				bind:value={query}
				type="search"
				class={s.SEARCH}
				placeholder="Search by name"
				aria-label="Search models"
			/>
		</div>

		<div class="max-h-[50dvh] space-y-1.5 overflow-y-auto">
			{#each shown as model (model.id)}
				{@const active = model.id === currentId}
				<button
					type="button"
					onclick={() => choose(model)}
					disabled={busy !== null}
					class="{s.card(active)} flex w-full items-center gap-2.5 px-3 py-2 text-left
							hover:border-blue-600/40 disabled:opacity-60"
					aria-current={active ? "true" : undefined}
				>
					{#if model.logoUrl}
						<img
							src={model.logoUrl}
							alt=""
							class="size-5 flex-none rounded-sm border bg-white dark:border-gray-700"
						/>
					{/if}
					<span class="min-w-0 flex-1">
						<span class="{s.CARD_TITLE} block">
							{model.name}{#if model.baseName}
								<span class="font-normal text-gray-500 dark:text-gray-400">
									· {model.baseName}</span
								>
								<span
									class="ml-1 rounded-full bg-blue-500/10 px-1.5 py-px align-middle text-[10px] font-medium text-blue-700 dark:text-blue-400"
									>custom</span
								>{/if}
						</span>
						<span class="block truncate text-xs text-gray-500 dark:text-gray-400"
							>{model.baseName ? (model.description ?? "Custom model") : model.id}</span
						>
					</span>
					{#if busy === model.id}
						<span class="loading-dots shrink-0 text-xs text-gray-500">Switching</span>
					{:else if active}
						<CarbonCheckmark class="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
					{/if}
				</button>
			{:else}
				<div class={s.EMPTY}>
					<CarbonSearch class={s.EMPTY_ICON} />
					<p class={s.EMPTY_TITLE}>No model matches that search.</p>
					<p class={s.EMPTY_DETAIL}>Try a shorter search, or clear it to see everything.</p>
					<button type="button" class={s.SECONDARY} onclick={() => (query = "")}>
						Clear the search
					</button>
				</div>
			{/each}
		</div>
	</div>
</Modal>
