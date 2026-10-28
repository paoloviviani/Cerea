<!--
	The deployment's instructions for every chat: one text, and whether users
	can read it in Settings. Chat only; coding agents never get it.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	let text = $state("");
	let visible = $state(true);
	let savedText = $state("");
	let savedVisible = $state(true);
	let max = $state(4000);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(text.trim() !== savedText || visible !== savedVisible);
	// Trimmed, like the server: trailing blanks are not saved, so not counted.
	const length = $derived(text.trim().length);
	const over = $derived(length > max);

	async function problem(response: Response): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(
			parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
		);
	}

	function apply(data: { instructions: string; visible: boolean }) {
		text = data.instructions;
		savedText = data.instructions;
		visible = data.visible;
		savedVisible = data.visible;
	}

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/instructions`);
			if (!response.ok) throw await problem(response);
			const data = await response.json();
			apply(data);
			max = data.max;
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
			const response = await fetch(`${base}/api/v2/admin/instructions`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instructions: text.trim(), visible }),
			});
			if (!response.ok) throw await problem(response);
			apply(await response.json());
			note = m["admin.instructions.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.common.save_failed"]();
		} finally {
			busy = false;
		}
	}

	function revert() {
		text = savedText;
		visible = savedVisible;
		note = null;
		failure = null;
	}
</script>

{#snippet code(value: string)}<code>{value}</code>{/snippet}

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">{m["admin.instructions.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">{m["admin.instructions.description"]()}</p>
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
					parts={m["admin.common.env_only"].parts({ name: "ADMIN_INSTRUCTIONS" })}
					tags={{ code }}
				/>
			</p>
		{/if}

		<div class="flex flex-col gap-1">
			<label for="admin-instructions-text" class="text-sm font-medium">
				{m["admin.instructions.label"]()}
			</label>
			<textarea
				id="admin-instructions-text"
				bind:value={text}
				disabled={!configurable || busy}
				rows="10"
				placeholder={m["admin.instructions.placeholder"]()}
				class="w-full rounded-lg border border-gray-300 bg-transparent p-3 font-mono text-xs dark:border-gray-600"
				data-testid="instructions-text"
			></textarea>
			<p
				class="text-right text-xs {over
					? 'text-red-600 dark:text-red-400'
					: 'text-gray-500 dark:text-gray-400'}"
				data-testid="instructions-count"
			>
				{m["admin.instructions.count"]({ count: length, max })}
			</p>
		</div>

		<label
			class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
		>
			<input
				type="checkbox"
				bind:checked={visible}
				disabled={!configurable || busy}
				class="mt-1"
				data-testid="instructions-visible"
			/>
			<span class="flex flex-col gap-0.5">
				<span class="font-medium">{m["admin.instructions.visible.title"]()}</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{m["admin.instructions.visible.description"]()}
				</span>
			</span>
		</label>

		<div class="flex flex-wrap items-center justify-between gap-3">
			<p class="text-xs text-gray-500 dark:text-gray-400">{note ?? ""}</p>
			<div class="flex items-center gap-2">
				<button
					onclick={revert}
					disabled={busy || !dirty}
					class="btn rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-gray-600"
				>
					{m["admin.instructions.revert"]()}
				</button>
				<button
					onclick={save}
					disabled={!configurable || busy || !dirty || over}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				>
					{busy ? m["admin.common.saving"]() : m["admin.common.save"]()}
				</button>
			</div>
		</div>
	{/if}
</section>
