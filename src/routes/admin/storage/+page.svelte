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
		if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	async function read(query = ""): Promise<Summary> {
		const response = await fetch(`${base}/api/v2/admin/storage${query}`);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
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
			failure = err instanceof Error ? err.message : "Could not read the setting.";
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
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			saved = wanted;
			note =
				wanted === 0
					? "Saved. Produced files are now kept until their conversation is deleted."
					: "Saved. It applies from the next sweep, within the hour.";
			summary = await read();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">Files produced by code</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			Documents, spreadsheets, PDFs and charts the assistant's code writes in the Python sandbox.
			Text artifacts and the files people upload are kept with their conversation and never expire;
			deleting a conversation deletes everything in it.
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
	{:else if summary}
		{#if !summary.configurable}
			<p
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				This deployment reads configuration from the environment only, so this cannot be changed
				here. Set <code>CHAT_FILE_RETENTION_DAYS</code> where the other variables live.
			</p>
		{/if}

		<p class="text-sm" data-testid="storage-usage">
			{summary.files === 0
				? "No produced files are stored."
				: `${summary.files} ${summary.files === 1 ? "file" : "files"} stored, ${size(summary.bytes)}.`}
		</p>

		<div class="flex flex-col gap-3">
			<label class="flex items-center gap-2 text-sm">
				<span>Keep produced files for</span>
				<input
					type="number"
					min="1"
					max={summary.maxDays}
					step="1"
					bind:value={days}
					disabled={forever || !summary.configurable || busy}
					class="w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
					aria-label="Days to keep produced files"
				/>
				<span>days</span>
			</label>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={forever} disabled={!summary.configurable || busy} />
				<span>Never expire (kept until the conversation is deleted)</span>
			</label>
			{#if !valid}
				<p class="text-xs text-red-700 dark:text-red-400">
					A whole number of days from 1 to {summary.maxDays}.
				</p>
			{/if}
			{#if shortening && preview}
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
					data-testid="storage-expiring"
				>
					{preview.files === 0
						? "No stored file is older than that: nothing is removed."
						: `${preview.files} ${preview.files === 1 ? "file" : "files"} (${size(preview.bytes)}) older than ${wanted} days will be deleted at the next sweep. They cannot be recovered.`}
				</p>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{#if note}{note}{:else}Default: {summary.defaultDays} days.{/if}
			</p>
			<button
				onclick={save}
				disabled={!summary.configurable || busy || !dirty}
				class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
			>
				{busy ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</section>
