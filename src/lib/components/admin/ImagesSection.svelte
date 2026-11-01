<!--
	Image generation: the model the assistant's image tool draws with, and
	whether each generation waits for the user's approval. A section of the
	Assistant tab (`/admin/assistant#images`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";

	type Status = {
		model: string | null;
		stored_model: string | null;
		available_models: string[];
		account_available?: boolean;
		account_reason?: string | null;
		ask_first: boolean;
	};

	let model = $state("");
	let savedModel = $state("");
	let askFirst = $state(false);
	let savedAskFirst = $state(false);
	let resolvedModel = $state<string | null>(null);
	let available = $state<string[]>([]);
	let accountAvailable = $state<boolean | null>(null);
	let accountReason = $state<string | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(model !== savedModel || askFirst !== savedAskFirst);

	function apply(data: Status) {
		accountAvailable = data.account_available ?? null;
		accountReason = data.account_reason ?? null;
		resolvedModel = data.model;
		available = data.available_models;
		savedModel = data.stored_model ?? "";
		model = savedModel;
		savedAskFirst = Boolean(data.ask_first);
		askFirst = savedAskFirst;
	}

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/images`);
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
			const response = await fetch(`${base}/api/v2/admin/images`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: model || null, ask_first: askFirst }),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.images.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	const accountReasonText = $derived(
		accountReason === "no_gateway"
			? m["admin.images.account_no_gateway"]()
			: accountReason === "gateway_unreachable"
				? m["admin.images.account_unreachable"]()
				: accountReason === "not_granted"
					? m["admin.images.account_not_granted"]()
					: m["admin.images.account_no_model"]()
	);

	onMount(load);
</script>

<section
	id="images"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.images.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.images.description"]()}</p>
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
				<span class="text-sm font-medium">{m["admin.images.label"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={model}
					disabled={busy}
					data-testid="image-model"
				>
					<option value="">{m["admin.images.default"]()}</option>
					{#each available as name (name)}
						<option value={name}>{name}</option>
					{/each}
				</select>
			</label>
			<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="images-model-state">
				{#if available.length === 0 && !resolvedModel}
					{m["admin.images.none"]()}
				{:else}
					{m["admin.images.hint"]()}
					{#if resolvedModel}
						{m["admin.images.current"]({ model: resolvedModel })}
					{/if}
				{/if}
			</p>
			{#if accountAvailable !== null}
				<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="images-account-state">
					{#if accountAvailable}
						{m["admin.images.account_yes"]()}
					{:else}
						{m["admin.images.account_no"]({ reason: accountReasonText })}
					{/if}
				</p>
			{/if}
			<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.images.grant_hint"]()}</p>
		</div>

		<label
			class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
		>
			<input
				type="checkbox"
				class="mt-1"
				bind:checked={askFirst}
				disabled={busy}
				data-testid="image-ask-first"
			/>
			<span class="flex flex-col gap-0.5">
				<span class="font-medium">{m["admin.images.ask_first.label"]()}</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{m["admin.images.ask_first.detail"]()}
				</span>
			</span>
		</label>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="save-images"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
