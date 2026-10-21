<!--
	Whether the composer offers dictation with the browser's own speech
	recognition. Sits beside the server-side recorder (the transcription model),
	and the default keeps the two from showing together.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";

	type Mode = "yes" | "no" | "fallback";

	const OPTIONS: { value: Mode; title: string; detail: string }[] = [
		{ value: "yes", title: "Yes", detail: "Always offer it, in browsers that support it." },
		{ value: "no", title: "No", detail: "Never offer it." },
		{
			value: "fallback",
			title: "Only when no voice model is available",
			detail:
				"Offer it only when the deployment has no server-side transcription model, so the recorder button and the dictation button are never shown together. This is the default.",
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
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			const data = await response.json();
			mode = data.mode;
			saved = data.mode;
			transcriptionEnabled = data.transcriptionEnabled;
			configurable = data.configurable;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not read the setting.";
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
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			saved = mode;
			note = "Saved. People see it the next time the page loads.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">Enable browser dictation</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			A microphone button in the composer that types what a person says, using the speech
			recognition built into their browser. Nothing is installed here and this deployment never
			receives the audio, but Chrome, Edge and Safari may send it to the browser vendor's cloud for
			recognition, and Firefox has none (the button is hidden there).
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
		<p class="text-sm text-gray-500">Loading…</p>
	{:else}
		{#if !configurable}
			<p
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				This deployment reads configuration from the environment only, so this cannot be changed
				here. Set <code>CHAT_DICTATION</code> where the other variables live.
			</p>
		{/if}

		<fieldset class="flex flex-col gap-2" disabled={!configurable || busy}>
			<legend class="sr-only">Enable browser dictation</legend>
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
						<span class="font-medium">{option.title}</span>
						<span class="text-xs text-gray-500 dark:text-gray-400">{option.detail}</span>
					</span>
				</label>
			{/each}
		</fieldset>

		<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="voice-model-state">
			{transcriptionEnabled
				? "This deployment has a voice model (server-side transcription): the recorder button is shown in the chat."
				: "This deployment has no voice model: there is no recorder button."}
		</p>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={!configurable || busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
			>
				{busy ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</section>
