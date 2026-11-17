<!-- Settings → Shared links: the user's own links, and Revoke (ADR 0120). -->
<script lang="ts">
	import { onMount } from "svelte";
	import { m } from "$lib/paraglide/messages";
	import { listShares, revokeShare, type ShareLink } from "$lib/utils/shareLinks";
	import SharedLinksList from "./SharedLinksList.svelte";

	let links = $state<ShareLink[]>([]);
	let enabled = $state(true);
	let loading = $state(true);
	let failure = $state(false);
	let busyId = $state<string | null>(null);

	async function load() {
		try {
			const result = await listShares();
			links = result.data;
			enabled = result.enabled;
		} catch {
			failure = true;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function revoke(link: ShareLink) {
		busyId = link.id;
		failure = false;
		try {
			await revokeShare(link.id);
			links = links.map((l) => (l.id === link.id ? { ...l, status: "revoked" as const } : l));
		} catch {
			failure = true;
		} finally {
			busyId = null;
		}
	}
</script>

<section class="flex flex-col gap-4">
	<div>
		<h2 class="text-lg font-semibold text-gray-800 dark:text-gray-200">
			{m["share.list.title"]()}
		</h2>
		<p class="text-sm text-gray-600 dark:text-gray-400">{m["share.list.intro"]()}</p>
	</div>
	{#if !enabled}
		<p
			class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
		>
			{m["share.list.off"]()}
		</p>
	{/if}
	{#if failure}
		<p class="text-sm text-red-600 dark:text-red-400" role="alert">{m["share.list.error"]()}</p>
	{/if}
	{#if loading}
		<p class="text-sm text-gray-500">{m["share.list.loading"]()}</p>
	{:else if links.length === 0}
		<p
			class="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
		>
			{m["share.list.empty"]()}
		</p>
	{:else}
		<SharedLinksList {links} {busyId} onrevoke={revoke} />
	{/if}
</section>
