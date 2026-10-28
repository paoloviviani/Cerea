<!--
	Custom models: the person's global system prompt, and their own custom
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
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
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
			throw new Error(
				parsed?.message ?? m["models.custom.error_status"]({ status: response.status })
			);
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
			failure = err instanceof Error ? err.message : m["models.custom.save_failed"]();
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
			failure = err instanceof Error ? err.message : m["models.custom.delete_failed"]();
		} finally {
			busy = false;
		}
	}

	function setDefault(model: CustomModelView) {
		settings.instantSet({ activeModel: model.id });
	}
</script>

{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}

<div class={s.EMBEDDED}>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 class={s.TITLE}>
				{view === "list"
					? m["models.custom.title"]()
					: editing
						? m["models.custom.edit_title"]({ name: editing.name })
						: m["models.custom.new_title"]()}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					{m["models.custom.subtitle"]()}
				{:else}
					{m["models.custom.form_subtitle"]()}
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
							{m["models.custom.count"]({ count: rows.length })}
						</p>
						<p class={s.STRIP_DETAIL}>
							{($settings.globalSystemPrompt ?? "").trim()
								? m["models.custom.global_set"]()
								: m["models.custom.global_unset"]()}
						</p>
					</div>
				</div>
				<button type="button" class={s.PRIMARY} onclick={() => begin(null)}>
					<CarbonAdd class="size-4" />
					{m["models.custom.new"]()}
				</button>
			</div>

			<div class={s.STACK}>
				{#if $settings.adminInstructions}
					<div data-testid="admin-instructions">
						<h3 class={s.SECTION_TITLE}>{m["models.custom.admin.title"]()}</h3>
						<textarea
							readonly
							aria-label={m["models.custom.admin.title"]()}
							class="{s.INPUT} min-h-24 cursor-default font-mono text-xs"
							value={$settings.adminInstructions}
						></textarea>
						<p class="{s.HINT} mt-1">{m["models.custom.admin.hint"]()}</p>
					</div>
				{/if}

				<div>
					<h3 class={s.SECTION_TITLE}>{m["models.custom.global.title"]()}</h3>
					<textarea
						id="global-system-prompt"
						aria-label={m["models.custom.global.title"]()}
						class="{s.INPUT} min-h-32 font-mono text-xs"
						placeholder={m["models.custom.global.placeholder"]()}
						maxlength={GLOBAL_SYSTEM_PROMPT_MAX}
						bind:value={globalDraft}
					></textarea>
					<div class="mt-1 flex items-center justify-between gap-3">
						<p class={s.HINT}>
							{m["models.custom.global.hint"]()}
						</p>
						<div class="flex shrink-0 items-center gap-2">
							{#if globalSaved && !globalDirty}
								<span class="{s.PILL} {s.PILL_TONES.good}">
									<IconCheckmark class="size-3" />
									{m["models.custom.global.saved"]()}
								</span>
							{/if}
							<button type="button" class={s.PRIMARY} disabled={!globalDirty} onclick={saveGlobal}>
								{m["models.custom.global.save"]()}
							</button>
						</div>
					</div>
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>{m["models.custom.list_heading"]({ count: rows.length })}</h3>
					{#if rows.length === 0}
						<div class={s.EMPTY}>
							<LucideSparkles class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>{m["models.custom.empty.title"]()}</p>
							<p class={s.EMPTY_DETAIL}>
								{m["models.custom.empty.detail"]()}
							</p>
							<button type="button" class={s.PRIMARY} onclick={() => begin(null)}>
								<CarbonAdd class="size-4" />
								{m["models.custom.new"]()}
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
													? m["models.custom.card.based_on"]({
															name: baseName(model.baseModelId) ?? "",
														})
													: m["models.custom.card.unavailable"]({ id: model.baseModelId })}
											</span>
											{#if isDefault}
												<span class="{s.PILL} {s.PILL_TONES.good}"
													>{m["models.custom.card.default"]()}</span
												>
											{/if}
										</div>
										{#if confirmingId === model.id}
											<div class="flex flex-wrap items-center gap-2">
												<p class="text-xs text-ink-muted">
													{m["models.custom.card.delete_confirm"]({ name: model.name })}
												</p>
												<button
													type="button"
													class={s.CARD_DESTRUCTIVE}
													disabled={busy}
													onclick={() => remove(model)}
												>
													<CarbonTrashCan class="size-3" />
													{m["models.custom.card.delete"]()}
												</button>
												<button
													type="button"
													class={s.CARD_ACTION}
													onclick={() => (confirmingId = null)}
												>
													{m["models.custom.card.cancel"]()}
												</button>
											</div>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#if isDefault}
													<span class="{s.CARD_ACTION} cursor-default opacity-60">
														<IconCheckmark class="size-3" />
														{m["models.custom.card.is_default"]()}
													</span>
												{:else}
													<button
														type="button"
														class={s.CARD_ACTION}
														disabled={!available}
														onclick={() => setDefault(model)}
													>
														<IconCheckmark class="size-3" />
														{m["models.custom.card.set_default"]()}
													</button>
												{/if}
												<button type="button" class={s.CARD_ACTION} onclick={() => begin(model)}>
													<CarbonEdit class="size-3" />
													{m["models.custom.card.edit"]()}
												</button>
												<button
													type="button"
													class={s.CARD_DESTRUCTIVE}
													onclick={() => (confirmingId = model.id)}
												>
													<CarbonTrashCan class="size-3" />
													{m["models.custom.card.delete"]()}
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
					<h4 class={s.TIPS_TITLE}>{m["models.custom.tips.title"]()}</h4>
					<ul class={s.TIPS_LIST}>
						<li>
							<Rich parts={m["models.custom.tips.inherits"].parts({})} tags={{ strong }} />
						</li>
						<li>
							<Rich parts={m["models.custom.tips.order"].parts({})} tags={{ strong }} />
						</li>
						<li>{m["models.custom.tips.private"]()}</li>
						<li>{m["models.custom.tips.delete"]()}</li>
					</ul>
				</div>
			</div>
		{:else}
			<div class={s.STACK}>
				<div class="flex">
					<button type="button" class={s.SECONDARY} onclick={backToList}>
						<IconArrowLeft class="size-4" />
						{m["models.custom.form.all"]()}
					</button>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-name">{m["models.custom.form.name"]()}</label>
					<input
						id="custom-model-name"
						class={s.INPUT}
						bind:value={name}
						maxlength={CUSTOM_MODEL_NAME_MAX}
						placeholder={m["models.custom.form.name_placeholder"]()}
					/>
					<p class={s.HINT}>{m["models.custom.form.name_hint"]()}</p>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-base">{m["models.custom.form.base"]()}</label>
					<select id="custom-model-base" class={s.INPUT} bind:value={baseModelId}>
						{#if baseModelId && baseName(baseModelId) === null}
							<option value={baseModelId}
								>{m["models.custom.form.base_gone"]({ id: baseModelId })}</option
							>
						{/if}
						{#each baseOptions as option (option.id)}
							<option value={option.id}>{option.displayName ?? option.name ?? option.id}</option>
						{/each}
					</select>
					<p class={s.HINT}>{m["models.custom.form.base_hint"]()}</p>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-description">
						{m["models.custom.form.description"]()}
						<span class="font-normal text-ink-faint">{m["models.custom.form.optional"]()}</span>
					</label>
					<input
						id="custom-model-description"
						class={s.INPUT}
						bind:value={description}
						maxlength={CUSTOM_MODEL_DESCRIPTION_MAX}
						placeholder={m["models.custom.form.description_placeholder"]()}
					/>
				</div>

				<div>
					<label class={s.LABEL} for="custom-model-prompt"
						>{m["models.custom.form.instructions"]()}</label
					>
					<textarea
						id="custom-model-prompt"
						class="{s.INPUT} min-h-40 font-mono text-xs"
						bind:value={systemPrompt}
						maxlength={CUSTOM_MODEL_PROMPT_MAX}
						placeholder={m["models.custom.form.instructions_placeholder"]()}
					></textarea>
					<p class={s.HINT}>
						{m["models.custom.form.instructions_hint"]()}
					</p>
				</div>

				<div class="flex gap-2">
					<button type="button" class={s.PRIMARY} disabled={!canSave} onclick={save}>
						{editing ? m["models.custom.form.save_changes"]() : m["models.custom.form.create"]()}
					</button>
					<button type="button" class={s.SECONDARY} onclick={backToList}
						>{m["models.custom.form.cancel"]()}</button
					>
				</div>
			</div>
		{/if}
	</div>
</div>
