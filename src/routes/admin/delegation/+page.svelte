<!--
	Whether the assistant may hand work to sub-agents: the `delegate` tool and
	the `research` preset. On by default; this is the deployment's off switch.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";

	let enabled = $state(true);
	let saved = $state(true);
	let configurable = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let note = $state<string | null>(null);

	const dirty = $derived(enabled !== saved);

	async function load() {
		try {
			const response = await fetch(`${base}/api/v2/admin/delegation`);
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			const data = await response.json();
			enabled = data.enabled;
			saved = data.enabled;
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
			const response = await fetch(`${base}/api/v2/admin/delegation`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
				);
			}
			saved = enabled;
			note = m["admin.delegation.saved"]();
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
		<h2 class="font-medium">{m["admin.delegation.title"]()}</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			<Rich
				parts={m["admin.delegation.description"].parts({ preset: "research" })}
				tags={{ code }}
			/>
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
					parts={m["admin.common.env_only"].parts({ name: "CHAT_DELEGATION" })}
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
				data-testid="delegation-toggle"
			/>
			<span class="flex flex-col gap-0.5">
				<span class="font-medium">{m["admin.delegation.allow.title"]()}</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					<Rich
						parts={m["admin.delegation.allow.description"].parts({
							delegate: "delegate",
							research: "research",
						})}
						tags={{ code }}
					/>
				</span>
			</span>
		</label>

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
	{/if}
</section>
