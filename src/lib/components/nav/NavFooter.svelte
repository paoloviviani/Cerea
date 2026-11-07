<!--
	The user row and its menu: the one place the sidebar keeps everything about
	*you* rather than about your work.

	The row is the avatar and name. Clicking it opens a menu upward from the
	foot of the panel, in this order: a small quota summary (how much you have
	spent against your limit, or the spend alone when there is none — the same
	report Settings → Usage & billing shows, and it links there), Settings,
	Admin (administrators), Console (when this deployment has one and you may
	open it — the same flag the Admin page's Console button reads), the theme
	switch, Reload, Sign out.

	This replaced the separate Settings and Admin rows and the inline icon row.
	The menu closes on Escape, on a click outside it and on following any link.

	Two things carried over from the previous footer, because they are about the
	endpoint rather than the control:

	**Logout is a form post, not a link.** `POST /logout` deletes the session
	server-side; a GET would make signing somebody out something a prefetch or
	an `<img>` could do to them.

	**It ends the session at both ends.** `POST /logout` also sends the browser
	to the provider's `end_session_endpoint` (see `routes/logout/+server.ts`), so
	the directory's own session goes too — without that half, the next visit
	re-authenticates silently and signing out looks like it did nothing.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { onDestroy } from "svelte";
	import { browser } from "$app/environment";
	import { switchTheme, subscribeToTheme } from "$lib/switchTheme";
	import { clearCodePanelCache } from "$lib/stores/codeTreeCache.svelte";
	import { clearProjectsCache } from "$lib/stores/projectsTreeCache.svelte";
	import { clearAllComposerDrafts } from "$lib/utils/composerDraft";
	import { clearTranscripts } from "$lib/stores/agentTranscriptCache";
	import IconSun from "$lib/components/icons/IconSun.svelte";
	import IconMoon from "$lib/components/icons/IconMoon.svelte";
	import { reloadApp } from "$lib/utils/appReload";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { formatCurrency, formatNumber } from "$lib/i18n/format";
	import { summariseQuota, type QuotaSummary } from "$lib/utils/quotaSummary";
	import type { UsageReport } from "$lib/types/UsageReport";
	import CarbonLogout from "~icons/carbon/logout";
	import CarbonRenew from "~icons/carbon/renew";
	import CarbonSettings from "~icons/carbon/settings";
	import CarbonUserAdmin from "~icons/carbon/user-admin";
	import CarbonLaunch from "~icons/carbon/launch";
	import CarbonChevronUp from "~icons/carbon/chevron-up";

	interface Props {
		/** `null` as well as `undefined`: that is what the layout's `user` is. */
		user: { username?: string; email?: string; avatarUrl?: string } | null | undefined;
		/** The gateway's own answer; the Admin item is for administrators only. */
		gatewayIsAdmin?: boolean | null;
	}

	let { user, gatewayIsAdmin = false }: Props = $props();

	const client = useAPIClient();

	const label = $derived(user?.username || user?.email || m["nav.footer.account"]());
	// Two letters, because an avatar is not always there and a coloured disc
	// with initials is what the rest of this deployment's consoles show.
	const initials = $derived(
		label
			.replace(/@.*$/, "")
			.split(/[.\-_\s]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);

	let isDark = $state(false);
	let unsubscribeTheme: (() => void) | undefined;
	if (browser) {
		unsubscribeTheme = subscribeToTheme(({ isDark: next }) => {
			isDark = next;
		});
	}
	onDestroy(() => unsubscribeTheme?.());

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	// The Console link: the deployment flag already folds in "this user may
	// open it" (feature-flags: CHAT_CONSOLE_ENABLED and consoleAllowedFor).
	const consoleEnabled = $derived(
		(page.data as { consoleEnabled?: boolean }).consoleEnabled === true
	);
	const usageEnabled = $derived((page.data as { usageEnabled?: boolean }).usageEnabled === true);

	// The quota summary is read when the menu opens, never on load: it is a
	// gateway call the sidebar must not make for every page view.
	let quota = $state<QuotaSummary | null>(null);
	let loadedAt = 0;
	const QUOTA_STALE_MS = 60_000;

	async function loadQuota() {
		if (!usageEnabled || Date.now() - loadedAt < QUOTA_STALE_MS) return;
		loadedAt = Date.now();
		try {
			const report = (await client.usage.get().then(handleResponse)) as UsageReport | null;
			quota = summariseQuota(report);
		} catch {
			quota = null;
			loadedAt = 0;
		}
	}

	function toggle() {
		open = !open;
		if (open) void loadQuota();
	}

	const money = (value: number, unit: string) =>
		/^[A-Z]{3}$/.test(unit) ? formatCurrency(value, unit) : `${formatNumber(value)} ${unit}`;

	$effect(() => {
		if (!open || !browser) return;
		const onPointer = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) open = false;
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") open = false;
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	});

	const ITEM =
		"flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-gray-700 no-underline hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700";
</script>

<div class="relative" bind:this={root}>
	{#if open}
		<div
			role="menu"
			data-testid="user-menu"
			class="absolute right-0 bottom-full left-0 z-40 mb-1 flex flex-col gap-px rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-800"
		>
			{#if usageEnabled && quota}
				<!-- Not a menu item to act on but a glance: spend against the limit,
				     the period it counts over, and the way to the full report. -->
				<a
					href="{base}/settings/usage"
					role="menuitem"
					data-testid="user-menu-quota"
					class="mb-1 flex flex-col gap-1 rounded-lg px-2 py-1.5 no-underline hover:bg-gray-100 dark:hover:bg-gray-700"
					onclick={() => (open = false)}
				>
					{#if quota.kind === "limit"}
						<span class="flex items-baseline justify-between gap-2 text-xs">
							<span class="font-medium text-gray-800 dark:text-gray-200">
								{m["nav.user_menu.quota_of"]({
									used: money(quota.used, quota.entry.unit),
									limit: money(quota.limit, quota.entry.unit),
								})}
							</span>
							{#if quota.entry.period}
								<span class="shrink-0 text-gray-500 dark:text-gray-400">{quota.entry.period}</span>
							{/if}
						</span>
						<span
							role="progressbar"
							aria-label={m["nav.user_menu.quota_label"]()}
							aria-valuemin={0}
							aria-valuemax={quota.limit}
							aria-valuenow={quota.used}
							data-near={quota.near}
							class="h-1 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
						>
							<span
								class="block h-full rounded-full {quota.near ? 'bg-amber-500' : 'bg-blue-600'}"
								style="width: {quota.percent}%"
							></span>
						</span>
					{:else}
						<span class="flex items-baseline justify-between gap-2 text-xs">
							<span class="font-medium text-gray-800 dark:text-gray-200">
								{m["nav.user_menu.quota_spent"]({ used: money(quota.used, quota.entry.unit) })}
							</span>
							{#if quota.entry.period}
								<span class="shrink-0 text-gray-500 dark:text-gray-400">{quota.entry.period}</span>
							{/if}
						</span>
					{/if}
				</a>
				<div class="mx-1 mb-1 border-t border-gray-200/70 dark:border-gray-700/70"></div>
			{/if}

			<a
				href="{base}/settings/application"
				role="menuitem"
				class={ITEM}
				onclick={() => (open = false)}
			>
				<CarbonSettings class="size-4 shrink-0" />
				{m["app.nav.settings"]()}
			</a>

			{#if gatewayIsAdmin}
				<!-- The chat's administration area (product decisions: which model reads
				     a document, what fetches a URL, which connectors everybody gets). The
				     panel's own gate re-asks the gateway; the item merely spares an
				     administrator the URL. -->
				<a href="{base}/admin" role="menuitem" class={ITEM} onclick={() => (open = false)}>
					<CarbonUserAdmin class="size-4 shrink-0" />
					{m["app.nav.admin"]()}
				</a>
			{/if}

			{#if consoleEnabled}
				<!-- The platform side (providers, prices, quotas, users): same origin,
				     not under the app's base path, exactly as the Admin page links it. -->
				<a
					href="/console"
					role="menuitem"
					data-testid="user-menu-console"
					class={ITEM}
					title={m["admin.layout.console_link"]()}
					onclick={() => (open = false)}
				>
					<CarbonLaunch class="size-4 shrink-0" />
					{m["admin.layout.console"]()}
				</a>
			{/if}

			<div class="mx-1 my-1 border-t border-gray-200/70 dark:border-gray-700/70"></div>

			<button type="button" role="menuitem" onclick={switchTheme} class={ITEM}>
				{#if browser && isDark}
					<IconSun classNames="size-4 shrink-0" />
					{m["nav.footer.light"]()}
				{:else}
					<IconMoon classNames="size-4 shrink-0" />
					{m["nav.footer.dark"]()}
				{/if}
			</button>

			<!-- An installed PWA has no address bar and no pull-to-refresh: this is its
			     only way to start over from the server when the page has drifted. -->
			<button
				type="button"
				role="menuitem"
				onclick={reloadApp}
				title={m["nav.footer.reload_label"]()}
				class={ITEM}
			>
				<CarbonRenew class="size-4 shrink-0" />
				{m["nav.footer.reload"]()}
			</button>

			<!-- A form post, not a link: signing somebody out must not be something a
			     prefetch can do to them. The submit clears this device's composer
			     drafts first — unsent text must not survive into the next person's
			     session on a shared browser — then the post proceeds as normal. -->
			<form
				method="POST"
				action="{base}/logout"
				class="flex"
				onsubmit={() => {
					clearAllComposerDrafts();
					clearTranscripts();
					clearCodePanelCache();
					clearProjectsCache();
				}}
			>
				<button
					type="submit"
					role="menuitem"
					class="{ITEM} hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
				>
					<CarbonLogout class="size-4 shrink-0" />
					{m["nav.footer.sign_out"]()}
				</button>
			</form>
		</div>
	{/if}

	<button
		type="button"
		onclick={toggle}
		aria-haspopup="menu"
		aria-expanded={open}
		data-testid="user-menu-button"
		class="flex h-10 w-full items-center gap-1.5 rounded-lg px-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
	>
		<span
			class="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[0.6rem] font-semibold text-white"
		>
			{initials}
		</span>
		<span class="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{label}</span>
		<CarbonChevronUp
			class="size-3.5 shrink-0 text-gray-400 transition-transform {open ? '' : 'rotate-180'}"
		/>
	</button>
</div>
