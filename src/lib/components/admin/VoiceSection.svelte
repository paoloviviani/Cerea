<!--
	How the composer does dictation: the browser's own speech recognition, a
	recording transcribed by the transcription model through the gateway, or
	nothing. One choice, so the two microphones never show together.

	A section of the Assistant tab (`/admin/assistant#voice`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	type Mode = "browser" | "model" | "off";

	const OPTIONS: { value: Mode; title: () => string; detail: () => string }[] = [
		{
			value: "browser",
			title: m["admin.voice.option.browser.title"],
			detail: m["admin.voice.option.browser.detail"],
		},
		{
			value: "model",
			title: m["admin.voice.option.model.title"],
			detail: m["admin.voice.option.model.detail"],
		},
		{
			value: "off",
			title: m["admin.voice.option.off.title"],
			detail: m["admin.voice.option.off.detail"],
		},
	];

	let mode = $state<Mode>("browser");
	let saved = $state<Mode>("browser");
	let legacy = $state(false);
	// The transcription model: "" is the deployment default.
	let model = $state("");
	let savedModel = $state("");
	let resolvedModel = $state<string | null>(null);
	let available = $state<string[]>([]);
	let modelBusy = $state(false);
	let modelFailure = $state<string | null>(null);
	let modelNote = $state<string | null>(null);
	const modelDirty = $derived(model !== savedModel);
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
			legacy = Boolean(data.legacyTranscription);
			await loadModel();
			configurable = data.configurable;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	async function loadModel() {
		const response = await fetch(`${base}/api/v2/admin/transcription`);
		if (!response.ok) return;
		applyModel(await response.json());
	}

	function applyModel(data: {
		model: string | null;
		stored_model: string | null;
		available_models: string[];
	}) {
		resolvedModel = data.model;
		available = data.available_models;
		savedModel = data.stored_model ?? "";
		model = savedModel;
	}

	async function saveModel() {
		modelBusy = true;
		modelFailure = null;
		modelNote = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/transcription`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: model || null }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			applyModel(await response.json());
			modelNote = m["admin.voice.transcription.saved"]();
		} catch (err) {
			modelFailure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			modelBusy = false;
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

		{#if legacy}
			<p
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				data-testid="voice-legacy"
			>
				{m["admin.voice.model_state.legacy"]()}
			</p>
		{/if}

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

		<div class="flex flex-col gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.voice.transcription.label"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={model}
					disabled={modelBusy}
					data-testid="transcription-model"
				>
					<option value="">{m["admin.voice.transcription.default"]()}</option>
					{#each available as name (name)}
						<option value={name}>{name}</option>
					{/each}
				</select>
			</label>
			<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="voice-model-state">
				{#if available.length === 0 && !resolvedModel}
					{m["admin.voice.transcription.none"]()}
				{:else}
					{m["admin.voice.transcription.hint"]()}
					{#if resolvedModel}
						{m["admin.voice.transcription.current"]({ model: resolvedModel })}
					{/if}
				{/if}
			</p>
			{#if modelFailure}
				<p class="text-xs text-red-700 dark:text-red-300">{modelFailure}</p>
			{/if}
			<div class="flex items-center justify-between gap-3">
				<p class="text-xs text-gray-500 dark:text-gray-400">{modelNote ?? ""}</p>
				<button
					onclick={saveModel}
					disabled={modelBusy || !modelDirty}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
					data-testid="save-transcription-model"
				>
					{modelBusy ? m["admin.common.saving"]() : m["admin.common.save"]()}
				</button>
			</div>
		</div>
	{/if}
</section>
