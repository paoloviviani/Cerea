<!--
	The model that writes chat titles. Automatic uses TASK_MODEL when the
	deployment sets one, else a non-reasoning model, else the chat's own.
	A section of the Assistant tab (`/admin/assistant#titles`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	type Status = {
		model: string | null;
		task_model: string | null;
		available_models: { id: string; name: string; reasoning: boolean }[];
		configurable: boolean;
	};

	let model = $state("");
	let savedModel = $state("");
	let available = $state<Status["available_models"]>([]);
	let taskModel = $state<string | null>(null);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(model !== savedModel);

	function apply(data: Status) {
		available = data.available_models;
		taskModel = data.task_model;
		configurable = data.configurable;
		savedModel = data.model ?? "";
		model = savedModel;
	}

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/title-model`);
			if (!response.ok) throw await problem(response);
			apply(await response.json());
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/title-model`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: model || null }),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.titles.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	onMount(load);
</script>

<section
	id="titles"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.titles.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.titles.description"]()}</p>
	</div>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
	{:else}
		<div class="flex flex-col gap-2">
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.titles.label"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={model}
					disabled={busy || !configurable}
					data-testid="title-model"
				>
					<option value="">{m["admin.titles.automatic"]()}</option>
					{#each available as option (option.id)}
						<option value={option.id}>
							{option.name}{option.reasoning ? ` (${m["admin.titles.reasoning"]()})` : ""}
						</option>
					{/each}
				</select>
			</label>
			<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="title-model-hint">
				{m["admin.titles.hint"]()}
				{#if taskModel}
					{m["admin.titles.task_model"]({ model: taskModel })}
				{/if}
			</p>
			{#if !configurable}
				<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.titles.env_only"]()}</p>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={busy || !dirty || !configurable}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="save-title-model"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
