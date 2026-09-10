<!--
	Choosing the model this chat runs on, as an overlay.

	The same shape as the MCP dialog, deliberately: a tinted strip saying what
	is configured and what is active, cards in two columns, the active one
	tinted blue. `/models` and `/models/[id]` stay as pages so a link into a
	model still resolves — this replaces the *way in from the nav*, not the
	addresses.

	Picking a card sets the active model and closes. There is no Save: the
	choice is one click and a dialog that then asks for confirmation of a
	radio button is a dialog nobody thanks you for.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import Modal from "$lib/components/Modal.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { mlAssistant } from "$lib/stores/mlAssistant.svelte";
	import { ML_ASSISTANT_MODE } from "$lib/utils/mlAssistantFlag";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconSearch from "~icons/carbon/search";
	import LucideHammer from "~icons/lucide/hammer";
	import LucideImage from "~icons/lucide/image";
	import LucideBoxes from "~icons/lucide/boxes";
	import IconArrowRight from "~icons/carbon/arrow-right";
	import * as s from "$lib/components/overlay/styles";

	interface ModelCard {
		id: string;
		name?: string;
		displayName?: string;
		description?: string | null;
		logoUrl?: string | null;
		unlisted?: boolean;
		isRouter?: boolean;
		multimodal?: boolean;
		supportsTools?: boolean;
	}

	interface Props {
		models: ModelCard[];
		mlAssistantModels?: string[];
		onclose: () => void;
	}

	let { models, mlAssistantModels = [], onclose }: Props = $props();

	const settings = useSettingsStore();

	let filter = $state("");
	const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
	const tokens = $derived(normalise(filter).trim().split(/\s+/).filter(Boolean));

	// With the ML Intern switch on, only the mode's fixed set is offered, in its
	// configured order — anything else would be swapped for the default on send.
	const mlOnly = $derived(ML_ASSISTANT_MODE && mlAssistant.enabled);
	const browsable = $derived(
		mlOnly
			? mlAssistantModels
					.map((id) => models.find((model) => model.id === id))
					.filter((model): model is ModelCard => model !== undefined)
			: models.filter((model) => !model.unlisted)
	);

	// Agents are addressed as models and appear in this list. They are labelled
	// rather than hidden: an agent is a model somebody made, and the one thing
	// they need to know is that picking it brings its instructions with it.
	const isAgent = (model: ModelCard) => model.id.startsWith("agent:");

	const shown = $derived(
		browsable.filter((model) => {
			const haystack = normalise(`${model.id} ${model.name ?? ""} ${model.displayName ?? ""}`);
			return tokens.every((token) => haystack.includes(token));
		})
	);

	const active = $derived(browsable.find((model) => model.id === $settings.activeModel));

	function choose(model: ModelCard) {
		settings.instantSet({ activeModel: model.id });
		onclose();
	}
</script>

<Modal width={s.OVERLAY_WIDE} {onclose} closeButton labelledBy="models-modal-title">
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="models-modal-title" class={s.TITLE}>Models</h2>
			<p class={s.SUBTITLE}>Choose the model this chat runs on.</p>
		</div>

		<div class="{s.STRIP} {active ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
			<div class="flex items-center gap-3">
				<div class={s.STRIP_TILE} class:grayscale={!active}>
					<LucideBoxes class="size-5 text-blue-600 dark:text-blue-500" />
				</div>
				<div>
					<p class={s.STRIP_HEADLINE}>
						{browsable.length}
						{browsable.length === 1 ? "model" : "models"} available
					</p>
					<p class={s.STRIP_DETAIL}>
						{active ? `${active.displayName || active.id} active` : "none chosen yet"}
					</p>
				</div>
			</div>
			<div class="flex gap-2">
				<a href="{base}/models" onclick={onclose} class={s.SECONDARY}>
					Full list
					<IconArrowRight class="size-4" />
				</a>
			</div>
		</div>

		<div class={s.STACK}>
			<div class="relative">
				<IconSearch
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
				/>
				<input
					type="search"
					bind:value={filter}
					placeholder="Search by name"
					aria-label="Search models by name or id"
					class="{s.SEARCH} pl-9"
				/>
			</div>

			{#if shown.length === 0}
				<div class={s.EMPTY}>
					<LucideBoxes class={s.EMPTY_ICON} />
					<p class={s.EMPTY_TITLE}>Nothing matches “{filter}”</p>
					<p class={s.EMPTY_DETAIL}>Try a shorter search, or clear it to see everything.</p>
					<button onclick={() => (filter = "")} class={s.PRIMARY}>Clear the search</button>
				</div>
			{:else}
				<div>
					<h3 class={s.SECTION_TITLE}>
						{mlOnly ? "ML Intern models" : "Available"} ({shown.length})
					</h3>
					<div class={s.GRID}>
						{#each shown as model (model.id)}
							{@const isActive = model.id === $settings.activeModel}
							<button
								type="button"
								onclick={() => choose(model)}
								class="{s.card(isActive)} text-left"
							>
								<div class={s.CARD_BODY}>
									<div class="mb-3 flex items-start justify-between gap-3">
										<div class="min-w-0 flex-1">
											<div class="mb-0.5 flex items-center gap-2">
												{#if model.logoUrl}
													<img src={model.logoUrl} alt="" class="size-4 flex-shrink-0 rounded-sm" />
												{/if}
												<h3 class={s.CARD_TITLE}>{model.displayName || model.id}</h3>
											</div>
											<p class={s.CARD_SUBTITLE}>
												{model.isRouter
													? "Routes your messages to the best model for your request."
													: model.description || model.id}
											</p>
										</div>
										{#if isActive}
											<IconCheckmark
												class="size-5 flex-shrink-0 text-blue-600 dark:text-blue-500"
											/>
										{/if}
									</div>

									<div class="flex flex-wrap items-center gap-2">
										{#if isActive}
											<span class="{s.PILL} {s.PILL_TONES.busy}">
												<IconCheckmark class="size-3" />
												In use
											</span>
										{/if}
										{#if isAgent(model)}
											<span class="{s.PILL} {s.PILL_TONES.neutral}">Agent</span>
										{/if}
										{#if model.supportsTools}
											<span
												class="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
											>
												<LucideHammer class="size-3" />
												tools
											</span>
										{/if}
										{#if model.multimodal}
											<span
												class="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
											>
												<LucideImage class="size-3" />
												images
											</span>
										{/if}
									</div>
								</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class={s.TIPS}>
				<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
				<ul class={s.TIPS_LIST}>
					<li>• The model you pick applies to new chats; an open chat keeps its own.</li>
					<li>• An <strong>Agent</strong> brings its own instructions and knowledge with it.</li>
					<li>• A router picks a model per message rather than pinning one.</li>
					<li>• Per-model settings, including custom prompts, live on the full list.</li>
				</ul>
			</div>
		</div>
	</div>
</Modal>
