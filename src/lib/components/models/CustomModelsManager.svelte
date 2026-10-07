<!--
	Customize models: the person's global system prompt, and their own custom
	models — a base model with a system prompt of its own.

	Two different things share the tab because they are the same decision seen
	from two sides: "what should the assistant always be told" (the global
	prompt, every chat turn) and "what should it be told when I pick this one"
	(a custom model). The order they reach the model in is the order they are
	drawn here: global, then the custom model's, then a project's context.

	A custom model is **private to its owner** and **never leaves Cerea**: the
	conversation keeps the custom id, and every turn is sent to the base model
	(`$lib/server/customModels`). It appears in the model pickers beside the
	catalogue, marked custom, with the base named.

	Drawn in the MCP dialog's language (`overlay/styles.ts`), switching between
	a list and a form inside the one screen on `view` rather than navigating.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { base } from "$app/paths";
	import { invalidateAll } from "$app/navigation";
	import * as s from "$lib/components/overlay/styles";
	import { useSettingsStore } from "$lib/stores/settings";
	import {
		CUSTOM_MODEL_DESCRIPTION_MAX,
		CUSTOM_MODEL_NAME_MAX,
		CUSTOM_MODEL_PROMPT_MAX,
		GLOBAL_SYSTEM_PROMPT_MAX,
		type CustomModelView,
	} from "$lib/types/CustomModel";
	import LucideSparkles from "~icons/lucide/sparkles";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import CarbonAdd from "~icons/carbon/add";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import IconArrowLeft from "~icons/carbon/arrow-left";

	interface ModelOption {
		id: string;
		displayName?: string;
		name?: string;
		unlisted?: boolean;
		customBase?: unknown;
	}

	interface Props {
		/** The models the chat offers (catalogue and custom alike). */
		models: ModelOption[];
		customModels: CustomModelView[];
		/** Open straight onto one custom model's form (`?id=custom:…`). */
		initialId?: string;
	}

	let { models, customModels, initialId }: Props = $props();

	const settings = useSettingsStore();

	/** What a custom model can be based on: catalogue models only. */
	const baseOptions = $derived(models.filter((model) => !model.customBase && !model.unlisted));
	const baseName = (id: string) => {
		const model = baseOptions.find((option) => option.id === id);
		return model ? (model.displayName ?? model.name ?? model.id) : null;
	};

	let rows = $state<CustomModelView[]>(untrack(() => customModels));

	type View = "list" | "form";
	const initial = untrack(() => rows.find((row) => row.id === initialId));
	let view = $state<View>(initial ? "form" : "list");
	/** The model being edited; null while creating. */
	let editing = $state<CustomModelView | null>(initial ?? null);
	let name = $state(initial?.name ?? "");
	let baseModelId = $state(initial?.baseModelId ?? "");
	let description = $state(initial?.description ?? "");
	let systemPrompt = $state(initial?.systemPrompt ?? "");

	let failure = $state<string | null>(null);
	let busy = $state(false);
	/** The row whose delete is awaiting its confirmation. */
	let confirmingId = $state<string | null>(null);

	// ---- the global prompt --------------------------------------------------

	let globalDraft = $state(untrack(() => $settings.globalSystemPrompt ?? ""));
	let globalSaved = $state(false);
	const globalDirty = $derived(globalDraft !== ($settings.globalSystemPrompt ?? ""));

	async function saveGlobal() {
		await settings.instantSet({ globalSystemPrompt: globalDraft.trim() });
		globalDraft = globalDraft.trim();
		globalSaved = true;
		setTimeout(() => (globalSaved = false), 3000);
	}

	// ---- custom models ------------------------------------------------------

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/custom-models${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : await response.json();
	}

	function begin(model: CustomModelView | null) {
		editing = model;
		name = model?.name ?? "";
		baseModelId = model?.baseModelId ?? baseOptions[0]?.id ?? "";
		description = model?.description ?? "";
		systemPrompt = model?.systemPrompt ?? "";
		failure = null;
		view = "form";
	}

	function backToList() {
		view = "list";
		editing = null;
		failure = null;
	}

	const canSave = $derived(
		name.trim().length > 0 && baseModelId !== "" && systemPrompt.trim().length > 0 && !busy
	);

	async function save() {
		if (!canSave) return;
		busy = true;
		failure = null;
		try {
			const payload = JSON.stringify({
				name: name.trim(),
				baseModelId,
				systemPrompt,
				// Always sent so that clearing it on an edit clears it.
				description: description.trim() || null,
			});
			const headers = { "Content-Type": "application/json" };
			const body = editing
				? await api<{ data: CustomModelView }>(`/${editing.id}`, {
						method: "PATCH",
						headers,
						body: payload,
					})
				: await api<{ data: CustomModelView }>("", { method: "POST", headers, body: payload });
			const saved = body.data;
			rows = editing
				? rows.map((row) => (row.id === saved.id ? saved : row))
				: [...rows, saved].sort((a, b) => a.name.localeCompare(b.name));
			backToList();
			// The pickers read the layout's model list: reload it.
			await invalidateAll();
		} catch (err) {
			failure = err instanceof Error ? err.message : "That custom model could not be saved.";
		} finally {
			busy = false;
		}
	}

	async function remove(model: CustomModelView) {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await api<void>(`/${model.id}`, { method: "DELETE" });
			rows = rows.filter((row) => row.id !== model.id);
			confirmingId = null;
			await invalidateAll();
		} catch (err) {
			failure = err instanceof Error ? err.message : "That custom model could not be deleted.";
		} finally {
			busy = false;
		}
	}

	function setDefault(model: CustomModelView) {
		settings.instantSet({ activeModel: model.id });
	}
</script>

<div class={s.EMBEDDED}>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 class={s.TITLE}>
				{view === "list"
					? "Customize models"
					: editing
						? `Edit ${editing.name}`
						: "New custom model"}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					Tell the assistant how to behave: once for every chat, or as a model of your own.
				{:else}
					A base model with a system prompt of its own. It is private to you.
				{/if}
			</p>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
		{/if}

		{#if view === "list"}
			<div class="{s.STRIP} {rows.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
				<div class="flex items-center gap-3">
					<div class="{s.STRIP_TILE} {rows.length > 0 ? '' : 'grayscale'}">
						<LucideSparkles class="size-5 text-accent" />
					</div>
					<div>
						<p class={s.STRIP_HEADLINE}>
							{rows.length}
							{rows.length === 1 ? "custom model" : "custom models"}
						</p>
						<p class={s.STRIP_DETAIL}>
							{($settings.globalSystemPrompt ?? "").trim()
								? "A global system prompt is set"
								: "No global system prompt"}
						</p>
					</div>
				</div>
				<button type="button" class={s.PRIMARY} onclick={() => begin(null)}>
					<CarbonAdd class="size-4" /> New custom model
				</button>
			</div>

			<div class={s.STACK}>
				<div>
					<h3 class={s.SECTION_TITLE}>Global system prompt</h3>
					<textarea
						id="global-system-prompt"
						aria-label="Global system prompt"
						class="{s.INPUT} min-h-32 font-mono text-xs"
						placeholder="Instructions every chat starts from, whatever the model."
						maxlength={GLOBAL_SYSTEM_PROMPT_MAX}
						bind:value={globalDraft}
					></textarea>
					<div class="mt-1 flex items-center justify-between gap-3">
						<p class={s.HINT}>
							Sent with every chat message, ahead of a custom model's own prompt and a project's
							context. Not used by the Agents panel, or to title a chat.
						</p>
						<div class="flex shrink-0 items-center gap-2">
							{#if globalSaved && !globalDirty}
								<span class="{s.PILL} {s.PILL_TONES.good}">
									<IconCheckmark class="size-3" /> Saved
								</span>
							{/if}
							<button type="button" class={s.PRIMARY} disabled={!globalDirty} onclick={saveGlobal}>
								Save
							</button>
						</div>
					</div>
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Custom models ({rows.length})</h3>
					{#if rows.length === 0}
						<div class={s.EMPTY}>
							<LucideSparkles class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>No custom models yet</p>
							<p class={s.EMPTY_DETAIL}>
								Pick a base model, write a system prompt, and it shows up in the model picker.
							</p>
							<button type="button" class={s.PRIMARY} onclick={() => begin(null)}>
								<CarbonAdd class="size-4" /> New custom model
							</button>
						</div>
					{:else}
						<div class={s.GRID}>
							{#each rows as model (model.id)}
								{@const isDefault = model.id === $settings.activeModel}
								{@const available = baseName(model.baseModelId) !== null}
								<div class={s.card(isDefault)} data-testid="custom-model-card">
									<div class={s.CARD_BODY}>
										<div class="mb-3 min-w-0">
											<div class="mb-0.5 flex items-center gap-2">
												<h4 class={s.CARD_TITLE}>{model.name}</h4>
												{#if isDefault}
													<IconCheckmark class="size-4 shrink-0 text-accent" />
												{/if}
											</div>
											<p class={s.CARD_SUBTITLE}>
												{model.description || model.systemPrompt}
											</p>
										</div>
										<div class="mb-3 flex flex-wrap items-center gap-2">
											<span class="{s.PILL} {available ? s.PILL_TONES.busy : s.PILL_TONES.bad}">
												{available
													? `based on ${baseName(model.baseModelId)}`
													: `${model.baseModelId} is unavailable`}
											</span>
											{#if isDefault}
												<span class="{s.PILL} {s.PILL_TONES.good}">Default</span>
											{/if}
										</div>
										{#if confirmingId === model.id}
											<div class="flex flex-wrap items-center gap-2">
												<p class="text-xs text-ink-muted">
													Delete “{model.name}”? Chats on it move to its base model.
												</p>
												<button
													type="button"
													class={s.CARD_DESTRUCTIVE}
													disabled={busy}
													onclick={() => remove(model)}
												>
													<CarbonTrashCan class="size-3" /> Delete
												</button>
												<button
													type="button"
													class={s.CARD_ACTION}
													onclick={() => (confirmingId = null)}
												>
													Cancel
												</button>
											</div>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#if isDefault}
													<span class="{s.CARD_ACTION} cursor-default opacity-60">
														<IconCheckmark class="size-3" /> Is the default
													</span>
												{:else}
													<button
														type="button"
														class={s.CARD_ACTION}
														disabled={!available}
														onclick={() => setDefault(model)}
													>
														<IconCheckmark class="size-3" /> Set as default
													</button>
												{/if}
												<button type="button" class={s.CARD_ACTION} onclick={() => begin(model)}>
													<CarbonEdit class="size-3" /> Edit
												</button>
												<button
													type="button"
													class={s.CARD_DESTRUCTIVE}
													onclick={() => (confirmingId = model.id)}
												>
													<CarbonTrashCan class="size-3" /> Delete
												</button>
											</div>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>
							• A custom model <strong>inherits everything</strong> from its base: vision, tools, reasoning
							and the effort options. Only the prompt is yours.
						</li>
						<li>
							• Prompts stack in order: <strong>global</strong>, then the
							<strong>custom model's</strong>, then a project's instructions.
						</li>
						<li>
							• Only your own chats see a custom model; the provider is only ever sent the base
							model.
						</li>
						<li>• Delete one and its chats carry on, on the base model.</li>
					</ul>
				</div>
			</div>
		{:else}
			<div class={s.STACK}>
				<div class="flex">
					<button type="button" class={s.SECONDARY} onclick={backToList}>
						<IconArrowLeft class="size-4" /> All custom models
					</button>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-name">Name</label>
					<input
						id="custom-model-name"
						class={s.INPUT}
						bind:value={name}
						maxlength={CUSTOM_MODEL_NAME_MAX}
						placeholder="Menu helper"
					/>
					<p class={s.HINT}>Shown in the model picker. Each of your custom models needs its own.</p>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-base">Base model</label>
					<select id="custom-model-base" class={s.INPUT} bind:value={baseModelId}>
						{#if baseModelId && baseName(baseModelId) === null}
							<option value={baseModelId}>{baseModelId} (no longer available)</option>
						{/if}
						{#each baseOptions as option (option.id)}
							<option value={option.id}>{option.displayName ?? option.name ?? option.id}</option>
						{/each}
					</select>
					<p class={s.HINT}>
						The model that does the work. Its capabilities and settings carry over.
					</p>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-description">
						Description <span class="font-normal text-ink-faint">(optional)</span>
					</label>
					<input
						id="custom-model-description"
						class={s.INPUT}
						bind:value={description}
						maxlength={CUSTOM_MODEL_DESCRIPTION_MAX}
						placeholder="Plans the week's lunches"
					/>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-prompt">System prompt</label>
					<textarea
						id="custom-model-prompt"
						class="{s.INPUT} min-h-40 font-mono text-xs"
						bind:value={systemPrompt}
						maxlength={CUSTOM_MODEL_PROMPT_MAX}
						placeholder="You are a menu planner. Always answer with a table."
					></textarea>
					<p class={s.HINT}>
						Applied to every message of a chat on this model, after your global prompt.
					</p>
				</div>

				<div class="flex gap-2">
					<button type="button" class={s.PRIMARY} disabled={!canSave} onclick={save}>
						{editing ? "Save changes" : "Create custom model"}
					</button>
					<button type="button" class={s.SECONDARY} onclick={backToList}>Cancel</button>
				</div>
			</div>
		{/if}
	</div>
</div>
