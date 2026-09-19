<!--
	Which backend fetches a URL somebody pastes into the composer.

	The distinction this screen exists to make: **fetching is not searching**.
	Given a plain URL you do not search for it, you fetch it — and the useful
	question is only what does the fetching.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";

	type Backend = "direct" | "playwright";

	const DESCRIPTIONS: Record<Backend, { title: string; detail: string }> = {
		direct: {
			title: "Direct",
			detail:
				"A plain HTTPS request — no browser, no JavaScript. Needs nothing else deployed, and is what this app has always done. A page built by JavaScript arrives as an empty shell with a 200 and nothing to say the content was never there.",
		},
		playwright: {
			title: "Local renderer (Playwright)",
			detail:
				"A headless browser in this deployment, driven over the Playwright protocol. Runs the page's JavaScript, so what is fetched is what a person would see. Needs the playwright compose overlay, which is opt-in and publishes no port.",
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
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			const data = await response.json();
			backend = data.backend;
			saved = data.backend;
			configurable = data.configurable;
			playwrightHealth = data.playwright ?? null;
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
			const response = await fetch(`${base}/api/v2/admin/fetching`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ backend }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			saved = backend;
			note = "Saved. It applies to the next fetch.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">Fetching a URL</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			What happens when somebody pastes a link into the composer. This is not web search — given a
			URL, the only question is what reads it.
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
				here. Set <code>FETCH_BACKEND</code> where the other variables live.
			</p>
		{/if}

		<div class="flex flex-col gap-2">
			{#if backend !== "direct" && backend !== "playwright"}
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				>
					The saved value (“{backend}”) is not a fetch backend this app offers — pick one below and
					save.
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
							<span class="text-sm font-medium">{meta.title}</span>
							{#if value === "playwright" && playwrightHealth}
								{#if playwrightHealth.reachable}
									<span
										class="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300"
									>
										Reachable
									</span>
								{:else}
									<span
										class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
										title={playwrightHealth.reason}
									>
										Unreachable{playwrightHealth.reason ? `: ${playwrightHealth.reason}` : ""}
									</span>
								{/if}
							{/if}
						</span>
						<span class="text-xs text-gray-600 dark:text-gray-400">{meta.detail}</span>
						{#if value === "playwright" && playwrightHealth && !playwrightHealth.reachable}
							<span class="text-xs text-amber-700 dark:text-amber-400">
								You can still select and save this — it may just not be deployed yet, or be starting
								up.
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
				{busy ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</section>
