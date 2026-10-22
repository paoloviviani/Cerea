<!--
	Whether the assistant may hand work to sub-agents: the `delegate` tool and
	the `research` preset. On by default; this is the deployment's off switch.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";

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
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			const data = await response.json();
			enabled = data.enabled;
			saved = data.enabled;
			configurable = data.configurable;
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
			const response = await fetch(`${base}/api/v2/admin/delegation`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
			}
			saved = enabled;
			note = "Saved. It applies to the next message anyone sends.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">Sub-agents</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			Lets the assistant hand a sub-task to a sub-agent that works on its own, in a fresh context,
			and returns only its answer, up to three at a time. The <code>research</code> preset is a sub-agent
			that searches the web and reads sources. Each sub-agent makes its own model calls, billed to the
			person like any message, and can use the chat's server-side tools, including connector tools the
			conversation already allows. It never raises an approval card: a tool that needs approval is refused.
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
				here. Set <code>CHAT_DELEGATION</code> where the other variables live.
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
				<span class="font-medium">Allow sub-agents</span>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Offered to models that can call tools. Turn it off to remove <code>delegate</code> and
					<code>research</code> from every chat.
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
				{busy ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</section>
