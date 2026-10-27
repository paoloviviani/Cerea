<!--
	Which backend fetches a URL somebody pastes into the composer.

	The distinction this screen exists to make: **fetching is not searching**.
	Given a plain URL you do not search for it, you fetch it — and the useful
	question is only what does the fetching.
-->
<script lang="ts">
	import * as s from "$lib/components/overlay/styles";
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	type Backend = "direct" | "playwright";

	const DESCRIPTIONS: Record<Backend, { title: () => string; detail: () => string }> = {
		direct: {
			title: m["admin.fetch.option.direct.title"],
			detail: m["admin.fetch.option.direct.detail"],
		},
		playwright: {
			title: m["admin.fetch.option.playwright.title"],
			detail: m["admin.fetch.option.playwright.detail"],
		},
	};

	let backend = $state<Backend>("direct");
	let saved = $state<Backend>("direct");
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);
	// A live probe of the renderer, shown next to the option but never used to
	// disable it: selecting playwright before its overlay is deployed is a
	// legitimate order of operations, and a transient probe failure must not
	// lock the setting rather than just warn about it (ADR 0079).
	let playwrightHealth = $state<{ reachable: boolean; reason?: string } | null>(null);

	const dirty = $derived(backend !== saved);

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/fetching`);
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			const data = await response.json();
			backend = data.backend;
			saved = data.backend;
			configurable = data.configurable;
			playwrightHealth = data.playwright ?? null;
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
			const response = await fetch(`${base}/api/v2/admin/fetching`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ backend }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			saved = backend;
			note = m["admin.fetch.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet code(text: string)}<code>{text}</code>{/snippet}

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.fetch.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			{m["admin.fetch.description"]()}
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
				<Rich parts={m["admin.common.env_only"].parts({ name: "FETCH_BACKEND" })} tags={{ code }} />
			</p>
		{/if}

		<div class="flex flex-col gap-2">
			{#if backend !== "direct" && backend !== "playwright"}
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				>
					{m["admin.fetch.unknown_backend"]({ backend })}
				</p>
			{/if}
			{#each Object.entries(DESCRIPTIONS) as [value, meta] (value)}
				<label
					class="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors {backend ===
					value
						? 'border-blue-600/40 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/10'
						: 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'}"
				>
					<input
						type="radio"
						name="fetch-backend"
						class="mt-1"
						value={value as Backend}
						bind:group={backend}
						disabled={!configurable || busy}
					/>
					<span class="flex flex-col gap-0.5">
						<span class="flex items-center gap-2">
							<span class="text-sm font-medium">{meta.title()}</span>
							{#if value === "playwright" && playwrightHealth}
								{#if playwrightHealth.reason === "not configured"}
									<span
										class="{s.PILL} {s.PILL_TONES.neutral}"
										title={m["admin.fetch.health.not_configured_hint"]({
											name: "PLAYWRIGHT_WS_ENDPOINT",
										})}
									>
										{m["admin.fetch.health.not_configured"]()}
									</span>
								{:else if playwrightHealth.reachable}
									<span class="{s.PILL} {s.PILL_TONES.good}">
										{m["admin.fetch.health.reachable"]()}
									</span>
								{:else}
									<span class="{s.PILL} {s.PILL_TONES.warn}" title={playwrightHealth.reason}>
										{playwrightHealth.reason
											? m["admin.fetch.health.unreachable_reason"]({
													reason: playwrightHealth.reason,
												})
											: m["admin.fetch.health.unreachable"]()}
									</span>
								{/if}
							{/if}
						</span>
						<span class="text-xs text-gray-600 dark:text-gray-400">{meta.detail()}</span>
						{#if value === "playwright" && playwrightHealth && !playwrightHealth.reachable}
							<span class="text-xs text-amber-700 dark:text-amber-400">
								{m["admin.fetch.health.can_still_select"]()}
							</span>
						{/if}
					</span>
				</label>
			{/each}
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{#if note}{note}{/if}
			</p>
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
