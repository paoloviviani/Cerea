<!--
	Which search backend web search runs on. The sibling of the document-reader
	choice on the Knowledge screen, and the same shape: the gateway offers the
	backends, an administrator picks one, an env value (`WEB_SEARCH_MODEL`)
	overrides it.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";

	interface Status {
		available_backends: string[];
		backend: string | null;
		stored_backend: string | null;
		source: "env" | "stored" | "policy";
		stale: boolean;
	}

	let status = $state<Status | null>(null);
	let choice = $state("");
	let loading = $state(true);
	let saving = $state(false);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);

	function adopt(next: Status) {
		status = next;
		choice = next.stored_backend ?? "";
	}

	async function request(init?: Parameters<typeof fetch>[1]): Promise<Status> {
		const response = await fetch(`${base}/api/v2/admin/web-search`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return (await response.json()) as Status;
	}

	onMount(async () => {
		try {
			adopt(await request());
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not read the setting.";
		} finally {
			loading = false;
		}
	});

	async function save(event: Event) {
		event.preventDefault();
		saving = true;
		failure = null;
		notice = null;
		try {
			adopt(
				await request({
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ backend: choice || null }),
				})
			);
			notice = "Saved. It applies to the next search.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700"
	onsubmit={save}
>
	<div class="flex flex-col gap-1">
		<h2 class="font-medium">Web search</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			Which search backend the “Web search” switch in chats uses. Backends are added in the
			gateway's console (Providers); each search is metered to the person who asked.
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
	{:else if status}
		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Search backend</span>
			{#if status.source === "env"}
				<div class="rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600">
					{status.backend ?? "(not offered to you)"} —
					<span class="text-xs">set in the environment</span>
				</div>
			{:else}
				<select
					class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={choice}
					disabled={status.available_backends.length === 0}
				>
					<option value="">Billing group's search policy (gateway default)</option>
					{#each status.available_backends as backend (backend)}
						<option value={backend}>{backend}</option>
					{/each}
				</select>
			{/if}
			<span class="text-xs text-gray-500 dark:text-gray-400">
				{#if status.available_backends.length === 0}
					No search backend in the gateway. Add one in the gateway console (Providers), then choose
					it here.
				{:else if status.source === "env"}
					Set with <code class="text-xs">WEB_SEARCH_MODEL</code> in the environment; this deployment's
					operator decided, not this screen.
				{:else if status.stale}
					The saved backend “{status.stored_backend}” is not offered to you, so searches fall back
					to the billing group's policy. Choose another.
				{:else if !status.stored_backend}
					None chosen: the gateway's billing-group search policy decides, and a group without one
					cannot search. Choose a backend to be sure web search works.
				{:else}
					Used by everyone who is granted it; anyone who is not falls back to their billing group's
					policy.
				{/if}
			</span>
		</label>

		{#if notice}
			<p class="text-sm text-gray-700 dark:text-gray-300">{notice}</p>
		{/if}

		{#if status.source !== "env"}
			<div class="flex justify-end">
				<button
					type="submit"
					disabled={saving || status.available_backends.length === 0}
					class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
		{/if}
	{/if}
</form>
