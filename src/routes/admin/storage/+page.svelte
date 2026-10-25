<!--
	What the chat keeps, and for how long.

	Today one setting: how many days files produced by code (documents,
	spreadsheets, charts from the Python sandbox) are kept. Text artifacts and
	uploaded attachments live with their conversation and have no expiry, which
	the screen says, so nobody reads this as "everything goes after N days".
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { formatNumber } from "$lib/i18n/format";
	import Rich from "$lib/i18n/Rich.svelte";

	interface Summary {
		retentionDays: number;
		defaultDays: number;
		maxDays: number;
		configurable: boolean;
		files: number;
		bytes: number;
		expiring: { files: number; bytes: number };
	}

	let summary = $state<Summary | null>(null);
	let forever = $state(false);
	let days = $state(30);
	let saved = $state(30);
	let preview = $state<Summary["expiring"] | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const wanted = $derived(forever ? 0 : days);
	const valid = $derived(
		forever || (Number.isInteger(days) && days >= 1 && days <= (summary?.maxDays ?? 3650))
	);
	const dirty = $derived(valid && wanted !== saved);
	// Only a shorter period removes anything; say so before it is saved.
	const shortening = $derived(dirty && wanted !== 0 && (saved === 0 || wanted < saved));

	function size(bytes: number): string {
		if (bytes < 1024 * 1024)
			return m["admin.storage.size.kb"]({
				value: formatNumber(Math.max(1, Math.round(bytes / 1024))),
			});
		if (bytes < 1024 * 1024 * 1024)
			return m["admin.storage.size.mb"]({
				value: formatNumber(bytes / (1024 * 1024), {
					minimumFractionDigits: 1,
					maximumFractionDigits: 1,
				}),
			});
		return m["admin.storage.size.gb"]({
			value: formatNumber(bytes / (1024 * 1024 * 1024), {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			}),
		});
	}

	async function read(query = ""): Promise<Summary> {
		const response = await fetch(`${base}/api/v2/admin/storage${query}`);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
			);
		}
		return response.json();
	}

	async function load() {
		try {
			summary = await read();
			saved = summary.retentionDays;
			forever = saved === 0;
			days = saved === 0 ? summary.defaultDays : saved;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.read_failed"]();
		} finally {
			loading = false;
		}
	}

	onMount(load);

	// The cost of a shorter period, asked for the value being typed.
	let previewToken = 0;
	$effect(() => {
		const target = wanted;
		if (!shortening) {
			preview = null;
			return;
		}
		const token = ++previewToken;
		const timer = setTimeout(async () => {
			try {
				const answer = await read(`?days=${target}`);
				if (token === previewToken) preview = answer.expiring;
			} catch {
				if (token === previewToken) preview = null;
			}
		}, 250);
		return () => clearTimeout(timer);
	});

	async function save() {
		busy = true;
		failure = null;
		note = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/storage`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ retentionDays: wanted }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			saved = wanted;
			note = wanted === 0 ? m["admin.storage.saved.forever"]() : m["admin.storage.saved.sweep"]();
			summary = await read();
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
		<h2 class="font-medium">{m["admin.storage.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			{m["admin.storage.description"]()}
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
	{:else if summary}
		{#if !summary.configurable}
			<p
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				<Rich
					parts={m["admin.common.env_only"].parts({ name: "CHAT_FILE_RETENTION_DAYS" })}
					tags={{ code }}
				/>
			</p>
		{/if}

		<p class="text-sm" data-testid="storage-usage">
			{summary.files === 0
				? m["admin.storage.usage.none"]()
				: m["admin.storage.usage.some"]({ count: summary.files, size: size(summary.bytes) })}
		</p>

		<div class="flex flex-col gap-3">
			<label class="flex items-center gap-2 text-sm">
				<span>{m["admin.storage.keep_for"]()}</span>
				<input
					type="number"
					min="1"
					max={summary.maxDays}
					step="1"
					bind:value={days}
					disabled={forever || !summary.configurable || busy}
					class="w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
					aria-label={m["admin.storage.days_label"]()}
				/>
				<span>{m["admin.storage.days_unit"]()}</span>
			</label>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={forever} disabled={!summary.configurable || busy} />
				<span>{m["admin.storage.never_expire"]()}</span>
			</label>
			{#if !valid}
				<p class="text-xs text-red-700 dark:text-red-400">
					{m["admin.storage.invalid"]({ max: summary.maxDays })}
				</p>
			{/if}
			{#if shortening && preview}
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
					data-testid="storage-expiring"
				>
					{preview.files === 0
						? m["admin.storage.preview.none"]()
						: m["admin.storage.preview.some"]({
								count: preview.files,
								size: size(preview.bytes),
								days: wanted,
							})}
				</p>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{#if note}{note}{:else}{m["admin.storage.default_days"]({ days: summary.defaultDays })}{/if}
			</p>
			<button
				onclick={save}
				disabled={!summary.configurable || busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
			>
				{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
			</button>
		</div>
	{/if}
</section>
