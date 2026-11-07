<!--
	The organisation's default look for slide decks: a theme, an accent colour
	and a logo, all optional and off by default. Decks can still override them
	in their front matter. A section of the Assistant tab (`/admin/assistant#slides`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { THEME_IDS, MAX_LOGO_DATA_URL } from "$lib/utils/slides/themes";

	const THEME_NAMES: Record<(typeof THEME_IDS)[number], () => string> = {
		cerea: m["admin.slides.theme_cerea"],
		"cerea-dark": m["admin.slides.theme_cerea_dark"],
		white: m["admin.slides.theme_white"],
		black: m["admin.slides.theme_black"],
		simple: m["admin.slides.theme_simple"],
		moon: m["admin.slides.theme_moon"],
		solarized: m["admin.slides.theme_solarized"],
		dracula: m["admin.slides.theme_dracula"],
	};

	type Defaults = { theme?: string; accent?: string; logo?: string };

	let theme = $state("");
	let accent = $state("");
	let logo = $state("");
	let saved = $state<Defaults>({});
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(
		theme !== (saved.theme ?? "") || accent !== (saved.accent ?? "") || logo !== (saved.logo ?? "")
	);

	function apply(data: { defaults: Defaults; configurable: boolean }) {
		saved = data.defaults;
		configurable = data.configurable;
		theme = saved.theme ?? "";
		accent = saved.accent ?? "";
		logo = saved.logo ?? "";
	}

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/slides`);
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
			const response = await fetch(`${base}/api/v2/admin/slides`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ theme, accent, logo }),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.slides.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	function pickLogo(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		failure = null;
		const reader = new FileReader();
		reader.onload = () => {
			const url = typeof reader.result === "string" ? reader.result : "";
			if (
				!url ||
				url.length > MAX_LOGO_DATA_URL ||
				!/^data:image\/(png|jpeg|webp|gif|svg\+xml);/.test(url)
			) {
				failure = m["admin.slides.logo_invalid"]();
				return;
			}
			logo = url;
		};
		reader.readAsDataURL(file);
	}

	onMount(load);
</script>

<section
	id="slides"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.slides.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.slides.description"]()}</p>
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
		<div class="grid gap-4 sm:grid-cols-3">
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.slides.theme"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={theme}
					disabled={busy || !configurable}
					data-testid="slides-theme"
				>
					<option value="">{m["admin.slides.off"]()}</option>
					{#each THEME_IDS as id (id)}
						<option value={id}>{THEME_NAMES[id]()}</option>
					{/each}
				</select>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.slides.accent"]()}</span>
				<span class="flex items-center gap-2">
					<input
						class="w-full rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						maxlength="7"
						bind:value={accent}
						disabled={busy || !configurable}
						data-testid="slides-accent"
					/>
					{#if /^#[0-9a-f]{6}$/i.test(accent)}
						<span class="size-6 flex-none rounded border border-gray-300" style:background={accent}
						></span>
					{/if}
				</span>
			</label>
			<div class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.slides.logo"]()}</span>
				<span class="flex items-center gap-2">
					{#if logo}
						<img
							src={logo}
							alt=""
							class="h-8 max-w-24 rounded border border-gray-200 object-contain"
						/>
						<button
							type="button"
							class="text-xs text-gray-500 underline"
							onclick={() => (logo = "")}
							disabled={busy || !configurable}>{m["admin.slides.logo_remove"]()}</button
						>
					{:else}
						<input
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
							class="w-full text-xs"
							onchange={pickLogo}
							disabled={busy || !configurable}
							data-testid="slides-logo"
						/>
					{/if}
				</span>
			</div>
		</div>
		{#if !configurable}
			<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.slides.env_only"]()}</p>
		{/if}

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={busy || !dirty || !configurable}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="save-slides"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
