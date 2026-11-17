<!--
	Administration: every shared link in the deployment, Revoke on each, and the
	one deployment-wide switch (ADR 0120). The switch overrides the environment's
	default (ARTIFACT_SHARING_ENABLED) once it has been set.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { m } from "$lib/paraglide/messages";
	import {
		adminRevokeShare,
		listAdminShares,
		setAdminSharing,
		type ShareLink,
	} from "$lib/utils/shareLinks";
	import SharedLinksList from "./SharedLinksList.svelte";

	let links = $state<ShareLink[]>([]);
	let enabled = $state(true);
	let envDefault = $state(true);
	let onAppOrigin = $state(false);
	let loading = $state(true);
	let failure = $state(false);
	let saved = $state(false);
	let busyId = $state<string | null>(null);
	let toggling = $state(false);

	onMount(async () => {
		try {
			const result = await listAdminShares();
			links = result.data;
			enabled = result.enabled;
			envDefault = result.envDefault;
			onAppOrigin = result.onAppOrigin;
		} catch {
			failure = true;
		} finally {
			loading = false;
		}
	});

	async function toggle(next: boolean) {
		toggling = true;
		failure = false;
		saved = false;
		try {
			enabled = (await setAdminSharing(next)).enabled;
			saved = true;
		} catch {
			failure = true;
		} finally {
			toggling = false;
		}
	}

	async function revoke(link: ShareLink) {
		busyId = link.id;
		failure = false;
		try {
			await adminRevokeShare(link.id);
			links = links.map((l) => (l.id === link.id ? { ...l, status: "revoked" as const } : l));
		} catch {
			failure = true;
		} finally {
			busyId = null;
		}
	}
</script>

<section id="shared-links" class="flex flex-col gap-4">
	<div>
		<h2 class="text-lg font-semibold text-gray-800 dark:text-gray-200">
			{m["share.admin.title"]()}
		</h2>
		<p class="text-sm text-gray-600 dark:text-gray-400">{m["share.admin.intro"]()}</p>
	</div>

	<label class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
		<input
			type="checkbox"
			role="switch"
			checked={enabled}
			disabled={loading || toggling}
			onchange={(event) => toggle(event.currentTarget.checked)}
		/>
		{m["share.admin.toggle"]()}
	</label>
	<p class="-mt-2 text-xs text-gray-500">
		{m["share.admin.env_default"]({
			state: envDefault ? m["share.admin.state_on"]() : m["share.admin.state_off"](),
		})}
	</p>
	{#if onAppOrigin}
		<p
			class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
		>
			{m["share.admin.app_origin_warning"]()}
		</p>
	{/if}
	{#if saved}<p class="text-sm text-green-700 dark:text-green-400" role="status">
			{m["share.admin.saved"]()}
		</p>{/if}
	{#if failure}<p class="text-sm text-red-600 dark:text-red-400" role="alert">
			{m["share.admin.error"]()}
		</p>{/if}

	{#if loading}
		<p class="text-sm text-gray-500">{m["share.list.loading"]()}</p>
	{:else if links.length === 0}
		<p
			class="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
		>
			{m["share.admin.empty"]()}
		</p>
	{:else}
		<SharedLinksList {links} showOwner {busyId} onrevoke={revoke} />
	{/if}
</section>
