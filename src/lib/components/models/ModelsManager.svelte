<!--
	Models: the whole list, and what each one can be set to.

	This **is** the full list — there is no "see all" leading anywhere else.
	Splitting a searchable list of cards across a dialog and a page meant two
	places showing the same models with different affordances, and the dialog
	was the one people opened.

	Two views, as everywhere else in this app's dialogs. The list, with a card
	per model; and one model, where it can be made the default and its own
	settings changed.

	**"Default" is what a new chat starts on.** An open conversation keeps the
	model it was started with, so changing this does not move a chat that is
	already running — which is why the button says "Set as default" rather than
	"Use", and why the card's pill says "Default" rather than "Active".

	One thing from the old settings page is deliberately not carried over:
	`providerOverrides`, which picks *which HuggingFace Inference Provider*
	serves a model. It is inherited from upstream and does nothing in a
	gateway deployment — every call goes to the gateway, and which upstream
	serves a model is the gateway's decision (ADR 0032). Its UI was already
	hidden behind `isHuggingChat`. The server-side plumbing is left alone,
	because it is live on the branch this fork came from.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { mlAssistant } from "$lib/stores/mlAssistant.svelte";
	import { ML_ASSISTANT_MODE } from "$lib/utils/mlAssistantFlag";
	import Switch from "$lib/components/Switch.svelte";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconSearch from "~icons/carbon/search";
	import IconSettings from "~icons/carbon/settings";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconReset from "~icons/carbon/reset";
	import LucideHammer from "~icons/lucide/hammer";
	import LucideImage from "~icons/lucide/image";
	import LucideBoxes from "~icons/lucide/boxes";
	import LucideBrain from "~icons/lucide/brain";
	import * as s from "$lib/components/overlay/styles";

	interface ModelCard {
		id: string;
		name?: string;
		displayName?: string;
		description?: string | null;
		logoUrl?: string | null;
		preprompt?: string | null;
		unlisted?: boolean;
		isRouter?: boolean;
		multimodal?: boolean;
		supportsTools?: boolean;
		supportsReasoning?: boolean;
		supportsArtifacts?: boolean;
	}

	/** One switch: what it is called, what it does, and where its value lives. */
	interface Capability {
		key: "tools" | "multimodal" | "reasoning" | "artifacts";
		label: string;
		detail: string;
		/** What the gateway advertises for this model, and the switch's default. */
		advertised: boolean;
		current: boolean;
		set: (value: boolean) => void;
	}

	interface Props {
		models: ModelCard[];
		mlAssistantModels?: string[];
		/** Open straight onto one model's settings, from anywhere in the app. */
		initialId?: string;
		onclose: () => void;
	}

	let { models, mlAssistantModels = [], initialId, onclose }: Props = $props();

	const settings = useSettingsStore();

	type View = "list" | "detail";
	// Read once: `initialId` is how the dialog was opened, not a prop that
	// changes under it.
	let view = $state<View>(untrack(() => (initialId ? "detail" : "list")));
	let current = $state<ModelCard | null>(
		untrack(() => models.find((model) => model.id === initialId) ?? null)
	);

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

	const shown = $derived(
		browsable.filter((model) => {
			const haystack = normalise(`${model.id} ${model.name ?? ""} ${model.displayName ?? ""}`);
			return tokens.every((token) => haystack.includes(token));
		})
	);

	const defaultModel = $derived(browsable.find((model) => model.id === $settings.activeModel));

	function setDefault(model: ModelCard) {
		settings.instantSet({ activeModel: model.id });
	}

	function open(model: ModelCard) {
		current = model;
		view = "detail";
	}

	/** Opened on one model, so the list is not part of this dialog. */
	const single = untrack(() => Boolean(initialId));

	function backToList() {
		if (single) {
			onclose();
			return;
		}
		view = "list";
		current = null;
	}

	// ---- one model's own settings -------------------------------------------
	//
	// Read and written straight through the settings store, per model id, the
	// same maps the per-model settings page uses. Nothing is cached in local
	// state: two editors of one value that disagree is worse than a re-render.

	const promptOf = $derived((id: string) => $settings.customPrompts?.[id] ?? "");
	const promptEnabledOf = $derived((id: string) => $settings.customPromptsEnabled?.[id] ?? true);

	function setPrompt(id: string, value: string) {
		settings.update((current) => ({
			...current,
			customPrompts: { ...current.customPrompts, [id]: value },
		}));
	}
	function setPromptEnabled(id: string, value: boolean) {
		settings.update((current) => ({
			...current,
			customPromptsEnabled: { ...current.customPromptsEnabled, [id]: value },
		}));
	}
	function setReasoning(id: string, value: boolean) {
		settings.update((current) => ({
			...current,
			reasoningOverrides: { ...current.reasoningOverrides, [id]: value },
		}));
	}
	function setArtifacts(id: string, value: boolean) {
		settings.update((current) => ({
			...current,
			artifactsOverrides: { ...current.artifactsOverrides, [id]: value },
		}));
	}
	function setTools(id: string, value: boolean) {
		settings.update((current) => ({
			...current,
			toolsOverrides: { ...current.toolsOverrides, [id]: value },
		}));
	}
	function setMultimodal(id: string, value: boolean) {
		settings.update((current) => ({
			...current,
			multimodalOverrides: { ...current.multimodalOverrides, [id]: value },
		}));
	}

	/**
	 * The four switches for one model.
	 *
	 * None is gated on the model advertising support. The advertised value is
	 * the default and the switch is the override — the same judgement the
	 * gateway makes about its own catalogue (ADR 0031): a claim rather than a
	 * contract, editable by somebody who has found out otherwise. Hiding a
	 * switch because a model does not claim a capability is how all four came
	 * to be missing.
	 */
	function capabilitiesFor(model: ModelCard): Capability[] {
		return [
			{
				key: "tools",
				label: "Tool calling",
				detail: "Let it call tools — MCP servers, and the built-in ones.",
				advertised: Boolean(model.supportsTools),
				current: $settings.toolsOverrides?.[model.id] ?? Boolean(model.supportsTools),
				set: (value) => setTools(model.id, value),
			},
			{
				key: "multimodal",
				label: "Image input",
				detail: "Accept image attachments and send them to the model.",
				advertised: Boolean(model.multimodal),
				current: $settings.multimodalOverrides?.[model.id] ?? Boolean(model.multimodal),
				set: (value) => setMultimodal(model.id, value),
			},
			{
				key: "reasoning",
				label: "Reasoning",
				detail: "Let it think before answering, and offer the effort selector.",
				advertised: Boolean(model.supportsReasoning),
				current: $settings.reasoningOverrides?.[model.id] ?? Boolean(model.supportsReasoning),
				set: (value) => setReasoning(model.id, value),
			},
			{
				key: "artifacts",
				label: "Artifacts",
				detail: "Show substantial output in a side panel rather than inline.",
				advertised: Boolean(model.supportsArtifacts),
				current: $settings.artifactsOverrides?.[model.id] ?? Boolean(model.supportsArtifacts),
				set: (value) => setArtifacts(model.id, value),
			},
		];
	}

	/** Whether the prompt has been changed from the model's own. */
	const promptIsCustom = $derived(
		(model: ModelCard) => promptOf(model.id) !== (model.preprompt ?? "")
	);
</script>

<Modal
	width={view === "list" ? s.OVERLAY_WIDE : s.OVERLAY_NARROW}
	{onclose}
	closeButton
	labelledBy="models-modal-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="models-modal-title" class={s.TITLE}>
				{view === "list" ? "Models" : current?.displayName || current?.id}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					Every model available to you. The default is what a new chat starts on.
				{:else}
					{current?.description || current?.id}
				{/if}
			</p>
		</div>

		{#if view === "list"}
			<div class="{s.STRIP} {defaultModel ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
				<div class="flex items-center gap-3">
					<div class={s.STRIP_TILE} class:grayscale={!defaultModel}>
						<LucideBoxes class="size-5 text-blue-600 dark:text-blue-500" />
					</div>
					<div>
						<p class={s.STRIP_HEADLINE}>
							{browsable.length}
							{browsable.length === 1 ? "model" : "models"} available
						</p>
						<p class={s.STRIP_DETAIL}>
							{defaultModel
								? `${defaultModel.displayName || defaultModel.id} is the default`
								: "no default chosen yet"}
						</p>
					</div>
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
								{@const isDefault = model.id === $settings.activeModel}
								<!-- A div, not a button: the card carries its own buttons, and
								     nesting one inside another is invalid and unreachable. -->
								<div class={s.card(isDefault)}>
									<div class={s.CARD_BODY}>
										<div class="mb-3 flex items-start justify-between gap-3">
											<div class="min-w-0 flex-1">
												<div class="mb-0.5 flex items-center gap-2">
													{#if model.logoUrl}
														<img src={model.logoUrl} alt="" class="size-4 shrink-0 rounded-sm" />
													{/if}
													<h3 class={s.CARD_TITLE}>{model.displayName || model.id}</h3>
												</div>
												<p class={s.CARD_SUBTITLE}>
													{model.isRouter
														? "Routes your messages to the best model for your request."
														: model.description || model.id}
												</p>
											</div>
											{#if isDefault}
												<IconCheckmark class="size-5 shrink-0 text-blue-600 dark:text-blue-500" />
											{/if}
										</div>

										<div class="mb-3 flex flex-wrap items-center gap-2">
											{#if isDefault}
												<span class="{s.PILL} {s.PILL_TONES.busy}">
													<IconCheckmark class="size-3" />
													Default
												</span>
											{/if}
											{#if promptIsCustom(model)}
												<span class="{s.PILL} {s.PILL_TONES.good}">custom prompt</span>
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
											{#if model.supportsReasoning}
												<span
													class="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
												>
													<LucideBrain class="size-3" />
													reasoning
												</span>
											{/if}
										</div>

										<div class="flex flex-wrap gap-1">
											{#if isDefault}
												<span class="{s.CARD_ACTION} cursor-default opacity-60">
													<IconCheckmark class="size-3" />
													Is the default
												</span>
											{:else}
												<button onclick={() => setDefault(model)} class={s.CARD_ACTION}>
													<IconCheckmark class="size-3" />
													Set as default
												</button>
											{/if}
											<button onclick={() => open(model)} class={s.CARD_ACTION}>
												<IconSettings class="size-3" />
												Edit
											</button>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>
							• The default is what a <strong>new</strong> chat starts on; an open chat keeps its own.
						</li>
						<li>• <strong>Edit</strong> gives a model its own system prompt, kept per model.</li>
						<li>• An <strong>Agent</strong> brings its own instructions and knowledge with it.</li>
						<li>• A router picks a model per message rather than pinning one.</li>
					</ul>
				</div>
			</div>
		{:else if current}
			{@const model = current}
			{@const isDefault = model.id === $settings.activeModel}
			<div class={s.STACK}>
				<div class="{s.STRIP} {isDefault ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
					<div class="flex items-center gap-3">
						<div class={s.STRIP_TILE} class:grayscale={!isDefault}>
							<LucideBoxes class="size-5 text-blue-600 dark:text-blue-500" />
						</div>
						<div>
							<p class={s.STRIP_HEADLINE}>
								{isDefault ? "The default for new chats" : "Not the default"}
							</p>
							<p class={s.STRIP_DETAIL}><code>{model.id}</code></p>
						</div>
					</div>
					<div class="flex gap-2">
						{#if !single}
							<button onclick={backToList} class={s.SECONDARY}>
								<IconArrowLeft class="size-4" />
								All models
							</button>
						{/if}
						{#if !isDefault}
							<button onclick={() => setDefault(model)} class={s.PRIMARY}>
								<IconCheckmark class="size-4" />
								Set as default
							</button>
						{/if}
					</div>
				</div>

				<div>
					<div class="mb-2 flex items-center justify-between gap-3">
						<h3 class="{s.SECTION_TITLE} mb-0">System prompt</h3>
						<Switch
							name="model-prompt-enabled"
							bind:checked={
								() => promptEnabledOf(model.id), (value) => setPromptEnabled(model.id, value)
							}
						/>
					</div>
					<textarea
						class="{s.INPUT} min-h-32 font-mono text-xs"
						placeholder="Instructions this model gets on every new conversation."
						disabled={!promptEnabledOf(model.id)}
						value={promptOf(model.id)}
						oninput={(event) => setPrompt(model.id, event.currentTarget.value)}
					></textarea>
					<div class="mt-1 flex items-center justify-between gap-3">
						<p class={s.HINT}>
							Yours, kept per model, and applied to conversations you start after saving it. The
							switch turns it off without losing it.
						</p>
						{#if promptIsCustom(model)}
							<button
								onclick={() => setPrompt(model.id, model.preprompt ?? "")}
								class="{s.CARD_ACTION} shrink-0"
							>
								<IconReset class="size-3" />
								Reset
							</button>
						{/if}
					</div>
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>What it may do</h3>
					<div class="flex flex-col divide-y divide-gray-200/60 dark:divide-gray-700/60">
						{#each capabilitiesFor(model) as capability (capability.key)}
							<label class="flex items-start justify-between gap-3 py-2.5 text-sm">
								<span class="min-w-0">
									{capability.label}
									<span class="block text-xs text-gray-500 dark:text-gray-400">
										{capability.detail}
									</span>
									{#if capability.current !== capability.advertised}
										<!-- Said out loud, because a switch disagreeing with the
										     model is the case where somebody needs to know which
										     of the two they are looking at. -->
										<span class="mt-0.5 block text-xs text-amber-700 dark:text-amber-500">
											{capability.advertised
												? "The gateway says this model supports it."
												: "The gateway does not report this model as supporting it."}
										</span>
									{/if}
								</span>
								<Switch
									name="model-{capability.key}"
									bind:checked={() => capability.current, (value) => capability.set(value)}
								/>
							</label>
						{/each}
					</div>
					<p class={s.HINT}>
						What the gateway advertises for this model is the default. These switches override it,
						for a model whose catalogue entry is wrong or incomplete.
					</p>
				</div>

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>
							• These are <strong>your</strong> settings for this model, not the deployment's.
						</li>
						<li>• They take effect on conversations you start from now on.</li>
					</ul>
				</div>
			</div>
		{/if}
	</div>
</Modal>
