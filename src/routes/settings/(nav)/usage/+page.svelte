<!--
	Usage & billing: every enabled `UsageProvider`'s report
	(`GET /api/v2/usage`), plus the billing-group selector that used to live on
	the Application tab (ADR 0061 — a gateway/bill-to concept, so it belongs
	here now).

	A page body runs on the server (AGENTS.md), so this fetches in `onMount`
	rather than a `+page.ts`/`+page.server.ts` load — matching every other
	manager screen in this app (KnowledgeManager, MCPServerManager, the
	Application tab's own billing-org fetch below).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { invalidateAll } from "$app/navigation";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { useSettingsStore } from "$lib/stores/settings";
	import { m } from "$lib/paraglide/messages";
	import UsageBar from "$lib/components/settings/UsageBar.svelte";
	import type { UsageReport, UsageSection } from "$lib/types/UsageReport";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";

	const client = useAPIClient();
	const settings = useSettingsStore();

	let sections = $state<UsageSection[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	// Billing group state, moved verbatim from
	// `settings/(nav)/application/+page.svelte`.
	type BillingOrg = { sub: string; name: string; preferred_username: string };
	let billingOrgs = $state<BillingOrg[]>([]);
	let billingOrgsLoading = $state(false);
	let billingOrgsError = $state<string | null>(null);

	function getBillingOrganization() {
		return $settings.billingOrganization ?? "";
	}
	function setBillingOrganization(v: string) {
		settings.update((s) => ({ ...s, billingOrganization: v }));
	}
	async function chooseBillingOrganization(v: string) {
		// The selector's own path. Persisted now, not through the settings
		// store's 300 ms debounce: the reload below re-runs the layout's load
		// functions, and those read what the server has stored — a
		// not-yet-persisted choice would come back as the previous group and
		// the list would not change at all. (The silent sync in `onMount`
		// keeps using `setBillingOrganization`: it follows the server's
		// answer, so it must not write one back.)
		await settings.instantSet({ billingOrganization: v });
		// The model list is per-caller and cached for a minute against a URL
		// that carries the billing group (`+layout.ts`'s `bill-to` query):
		// the reload misses that cache, so the model picker and everything
		// else reading `data.models` shows the new group's models at once.
		await invalidateAll();
	}

	onMount(async () => {
		try {
			const report = (await client.usage.get().then(handleResponse)) as UsageReport | null;
			sections = report?.sections ?? [];
		} catch {
			loadError = m["settings.usage.load_failed"]();
		} finally {
			loading = false;
		}

		// Which group pays (ADR 0061). The gateway answers this for every
		// deployment, and the endpoint reports an empty list when it cannot, so
		// the section below hides itself.
		if (page.data.user) {
			billingOrgsLoading = true;
			try {
				const data = (await client.user["billing-orgs"].get().then(handleResponse)) as {
					userCanPay: boolean;
					organizations: BillingOrg[];
					currentBillingOrg?: string;
				};
				billingOrgs = data.organizations ?? [];
				if (data.currentBillingOrg !== getBillingOrganization()) {
					setBillingOrganization(data.currentBillingOrg ?? "");
				}
			} catch {
				billingOrgsError = m["settings.usage.billing_load_failed"]();
			} finally {
				billingOrgsLoading = false;
			}
		}
	});
</script>

{#if !page.data.usageEnabled}
	<!--
		Reachable only by navigating here directly with the flag off — the tab
		itself is already absent from `settings/+layout.svelte`'s `sections`.
	-->
	<div
		class="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500 shadow-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
	>
		{m["settings.usage.unavailable"]()}
	</div>
{:else}
	<div class="flex w-full flex-col gap-4">
		{#if loading}
			<p class="text-sm text-gray-500 dark:text-gray-400">{m["settings.usage.loading"]()}</p>
		{:else if loadError}
			<div
				class="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm text-gray-500 shadow-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
			>
				{loadError}
			</div>
		{:else if sections.length === 0}
			<p class="text-sm text-gray-500 dark:text-gray-400">{m["settings.usage.none"]()}</p>
		{:else}
			{#each sections as section (section.title)}
				<div
					class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
				>
					<div class="flex items-center justify-between py-3">
						<h2 class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{section.title}
						</h2>
						{#if section.link}
							<a
								href={section.link.href}
								target="_blank"
								rel="noreferrer"
								class="flex items-center gap-1 text-[12px] text-blue-600 hover:underline dark:text-blue-400"
							>
								{section.link.label}
								<CarbonArrowUpRight class="text-xs" />
							</a>
						{/if}
					</div>
					{#if section.error}
						<p class="pb-3 text-[12px] text-amber-600 dark:text-amber-400">{section.error}</p>
					{:else if section.entries.length === 0}
						<p class="pb-3 text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.usage.nothing"]()}
						</p>
					{:else}
						<div class="divide-y divide-gray-200 dark:divide-gray-700">
							{#each section.entries as entry (entry.label)}
								<UsageBar {entry} />
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}

		<!-- Which group pays (ADR 0061). Shown once the gateway names at least
		     one billable group, so a deployment that does not answer shows
		     nothing rather than an empty control. -->
		{#if page.data.user && billingOrgs.length > 0}
			<div
				class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							{m["settings.usage.billing_group.title"]()}
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							{m["settings.usage.billing_group.description"]()}
						</p>
					</div>
					<div class="flex items-center">
						{#if billingOrgsLoading}
							<span class="text-xs text-gray-500 dark:text-gray-400"
								>{m["settings.usage.loading_short"]()}</span
							>
						{:else if billingOrgsError}
							<span class="text-xs text-red-500">{billingOrgsError}</span>
						{:else}
							<select
								class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
								value={getBillingOrganization()}
								onchange={(e) => chooseBillingOrganization(e.currentTarget.value)}
							>
								{#each billingOrgs as org}
									<option value={org.preferred_username} title={org.name}
										>{org.preferred_username}</option
									>
								{/each}
							</select>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}
