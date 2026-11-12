<!--
	Browser use (ADR 0116): whether the assistant may do tasks in a real browser on a user's own
	machine, which model runs the browsing agent, the budgets for one task and the site lists.
	Off by default. A section of the Assistant tab (`/admin/assistant#browser`).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	type Status = {
		enabled: boolean;
		model: string | null;
		max_steps: number;
		max_tokens: number;
		max_seconds: number;
		sites_allow: string[];
		sites_deny: string[];
		limits: Record<"maxSteps" | "maxTokens" | "maxSeconds", { min: number; max: number }>;
		available_models: { id: string; name: string }[];
		configurable: boolean;
	};

	let enabled = $state(false);
	let model = $state("");
	let maxSteps = $state(25);
	let maxTokens = $state(200000);
	let maxSeconds = $state(300);
	let allow = $state("");
	let deny = $state("");
	let saved = $state("");
	let available = $state<Status["available_models"]>([]);
	let limits = $state<Status["limits"] | null>(null);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const snapshot = () =>
		JSON.stringify([enabled, model, maxSteps, maxTokens, maxSeconds, allow, deny]);
	const dirty = $derived(snapshot() !== saved);

	function apply(data: Status) {
		available = data.available_models;
		limits = data.limits;
		configurable = data.configurable;
		enabled = data.enabled;
		model = data.model ?? "";
		maxSteps = data.max_steps;
		maxTokens = data.max_tokens;
		maxSeconds = data.max_seconds;
		allow = data.sites_allow.join("\n");
		deny = data.sites_deny.join("\n");
		saved = snapshot();
	}

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/browser`);
			if (!response.ok) throw await problem(response);
			apply(await response.json());
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	const lines = (text: string) =>
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/browser`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enabled,
					model: model || null,
					max_steps: Number(maxSteps),
					max_tokens: Number(maxTokens),
					max_seconds: Number(maxSeconds),
					sites_allow: lines(allow),
					sites_deny: lines(deny),
				}),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.browser.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	onMount(load);
</script>

{#snippet code(text: string)}<code>{text}</code>{/snippet}

<section
	id="browser"
	class="flex scroll-mt-4 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.browser.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			<Rich parts={m["admin.browser.description"].parts({})} tags={{ code }} />
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
					parts={m["admin.common.env_only"].parts({ name: "CHAT_BROWSER_ENABLED" })}
					tags={{ code }}
				/>
			</p>
		{/if}

		<label
			class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
		>
			<input
				type="checkbox"
				bind:checked={enabled}
				disabled={!configurable || busy}
				class="mt-1"
				data-testid="browser-toggle"
			/>
			<span class="flex flex-col gap-0.5">
				<span class="font-medium">{m["admin.browser.enable.title"]()}</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					<Rich
						parts={m["admin.browser.enable.description"].parts({ browse: "browse" })}
						tags={{ code }}
					/>
				</span>
			</span>
		</label>

		<div class="flex flex-col gap-2">
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.browser.model.label"]()}</span>
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={model}
					disabled={busy || !configurable}
					data-testid="browser-model"
				>
					<option value="">{m["admin.browser.model.same"]()}</option>
					{#each available as option (option.id)}
						<option value={option.id}>{option.name}</option>
					{/each}
				</select>
			</label>
			<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.browser.model.hint"]()}</p>
		</div>

		<div class="flex flex-col gap-2">
			<h3 class="text-sm font-medium">{m["admin.browser.budgets.title"]()}</h3>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<label class="flex flex-col gap-1 text-sm">
					<span>{m["admin.browser.budgets.steps"]()}</span>
					<input
						type="number"
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={maxSteps}
						min={limits?.maxSteps.min}
						max={limits?.maxSteps.max}
						disabled={busy || !configurable}
						data-testid="browser-max-steps"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span>{m["admin.browser.budgets.tokens"]()}</span>
					<input
						type="number"
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={maxTokens}
						min={limits?.maxTokens.min}
						max={limits?.maxTokens.max}
						disabled={busy || !configurable}
						data-testid="browser-max-tokens"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span>{m["admin.browser.budgets.seconds"]()}</span>
					<input
						type="number"
						class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={maxSeconds}
						min={limits?.maxSeconds.min}
						max={limits?.maxSeconds.max}
						disabled={busy || !configurable}
						data-testid="browser-max-seconds"
					/>
				</label>
			</div>
			<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.browser.budgets.hint"]()}</p>
		</div>

		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.browser.sites.allow.label"]()}</span>
				<textarea
					class="min-h-24 rounded-lg border border-gray-300 bg-white p-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={allow}
					disabled={busy || !configurable}
					spellcheck="false"
					data-testid="browser-sites-allow"
				></textarea>
				<span class="text-xs text-gray-500 dark:text-gray-400"
					>{m["admin.browser.sites.allow.hint"]()}</span
				>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">{m["admin.browser.sites.deny.label"]()}</span>
				<textarea
					class="min-h-24 rounded-lg border border-gray-300 bg-white p-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={deny}
					disabled={busy || !configurable}
					spellcheck="false"
					data-testid="browser-sites-deny"
				></textarea>
				<span class="text-xs text-gray-500 dark:text-gray-400"
					>{m["admin.browser.sites.deny.hint"]()}</span
				>
			</label>
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<button
				onclick={save}
				disabled={!configurable || busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				data-testid="browser-save"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
