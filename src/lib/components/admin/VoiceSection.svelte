<!--
	Whether the composer offers dictation with the browser's own speech
	recognition. Sits beside the server-side recorder (the transcription model),
	and the default keeps the two from showing together.

	A section of the Assistant tab (`/admin/assistant#voice`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	type Mode = "yes" | "no" | "fallback";

	const OPTIONS: { value: Mode; title: () => string; detail: () => string }[] = [
		{
			value: "yes",
			title: m["admin.voice.option.yes.title"],
			detail: m["admin.voice.option.yes.detail"],
		},
		{
			value: "no",
			title: m["admin.voice.option.no.title"],
			detail: m["admin.voice.option.no.detail"],
		},
		{
			value: "fallback",
			title: m["admin.voice.option.fallback.title"],
			detail: m["admin.voice.option.fallback.detail"],
		},
	];

	let mode = $state<Mode>("fallback");
	let saved = $state<Mode>("fallback");
	let transcriptionEnabled = $state(false);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(mode !== saved);

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/dictation`);
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			const data = await response.json();
			mode = data.mode;
			saved = data.mode;
			transcriptionEnabled = data.transcriptionEnabled;
			configurable = data.configurable;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/dictation`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			saved = mode;
			note = m["admin.voice.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet code(text: string)}<code>{text}</code>{/snippet}

<section
	id="voice"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.voice.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			{m["admin.voice.description"]()}
		</p>
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
		{#if !configurable}
			<p
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				<Rich
					parts={m["admin.common.env_only"].parts({ name: "CHAT_DICTATION" })}
					tags={{ code }}
				/>
			</p>
		{/if}

		<fieldset class="flex flex-col gap-2" disabled={!configurable || busy}>
			<legend class="sr-only">{m["admin.voice.title"]()}</legend>
			{#each OPTIONS as option (option.value)}
				<label
					class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm {mode ===
					option.value
						? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
						: 'border-gray-200 dark:border-gray-700'}"
				>
					<input
						type="radio"
						name="dictation"
						value={option.value}
						bind:group={mode}
						class="mt-1"
					/>
					<span class="flex flex-col gap-0.5">
						<span class="font-medium">{option.title()}</span>
						<span class="text-xs text-gray-500 dark:text-gray-400">{option.detail()}</span>
					</span>
				</label>
			{/each}
		</fieldset>

		<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="voice-model-state">
			{transcriptionEnabled
				? m["admin.voice.model_state.with_model"]()
				: m["admin.voice.model_state.without_model"]()}
		</p>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={!configurable || busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
