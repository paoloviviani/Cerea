<!--
	Models hidden from the chat picker: a switch per gateway chat model. A hidden
	model is not offered to users but stays usable for internal tasks (the title
	model) and in chats already on it. A section of the Assistant tab
	(`/admin/assistant#hidden-models`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	type Row = {
		id: string;
		name: string;
		reasoning: boolean;
		hidden: boolean;
		env_unlisted: boolean;
		is_default: boolean;
	};

	let rows = $state<Row[]>([]);
	let hidden = $state<string[]>([]);
	let saved = $state<string[]>([]);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(
		hidden.length !== saved.length || hidden.some((id) => !saved.includes(id))
	);

	function apply(data: { configurable: boolean; models: Row[] }) {
		rows = data.models;
		configurable = data.configurable;
		saved = data.models.filter((r) => r.hidden).map((r) => r.id);
		hidden = [...saved];
	}

	function toggle(id: string, on: boolean) {
		hidden = on ? [...hidden, id] : hidden.filter((x) => x !== id);
	}

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/hidden-models`);
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
			const response = await fetch(`${base}/api/v2/admin/hidden-models`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hidden }),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.hidden_models.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	onMount(load);
</script>

<section
	id="hidden-models"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.hidden_models.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.hidden_models.description"]()}</p>
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
		{#if rows.length === 0}
			<p class="text-sm text-gray-500">{m["admin.hidden_models.empty"]()}</p>
		{:else}
			<ul class="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
				{#each rows as row (row.id)}
					{@const locked = row.is_default || row.env_unlisted}
					<li class="flex items-center justify-between gap-3 py-2">
						<label class="flex flex-1 items-center justify-between gap-3 text-sm">
							<span class="flex flex-col">
								<span class="font-medium">{row.name}</span>
								<span class="text-xs text-gray-500 dark:text-gray-400">
									{row.id}{row.reasoning
										? ` · ${m["admin.titles.reasoning"]()}`
										: ""}{row.is_default
										? ` · ${m["admin.hidden_models.default"]()}`
										: ""}{row.env_unlisted ? ` · ${m["admin.hidden_models.env"]()}` : ""}
								</span>
							</span>
							<input
								type="checkbox"
								role="switch"
								class="size-4"
								aria-label={`${m["admin.hidden_models.switch"]()}: ${row.name}`}
								checked={row.env_unlisted || hidden.includes(row.id)}
								disabled={busy || !configurable || locked}
								onchange={(e) => toggle(row.id, e.currentTarget.checked)}
								data-testid={`hide-${row.id}`}
							/>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.hidden_models.hint"]()}</p>
		{#if !configurable}
			<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.hidden_models.env_only"]()}</p>
		{/if}

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={busy || !dirty || !configurable}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="save-hidden-models"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
