<!--
	Starter suggestions: four ideas under the greeting on a new chat. Off by
	default. A section of the Assistant tab.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	let enabled = $state(false);
	let saved = $state(false);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(enabled !== saved);

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	onMount(async () => {
		try {
			const response = await fetch(`${base}/api/v2/admin/starters`);
			if (!response.ok) throw await problem(response);
			const data = (await response.json()) as { enabled: boolean; configurable?: boolean };
			saved = enabled = data.enabled;
			configurable = data.configurable !== false;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	});

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/starters`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) throw await problem(response);
			saved = enabled = ((await response.json()) as { enabled: boolean }).enabled;
			note = m["admin.starters.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}
</script>

<section
	id="starters"
	class="flex flex-col gap-4 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<h2 class="font-medium">{m["admin.starters.title"]()}</h2>

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
		<label class="flex cursor-pointer items-center gap-3 text-sm">
			<input
				type="checkbox"
				bind:checked={enabled}
				disabled={busy || !configurable}
				data-testid="starters-enabled"
			/>
			{m["admin.starters.label"]()}
		</label>
		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				type="button"
				onclick={save}
				disabled={busy || !dirty || !configurable}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="save-starters"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
