<!--
	The person, at the foot of the tree, and what they can do about it.

	Opens **upward**, because it lives at the bottom of the panel and a menu
	that dropped down would be off-screen. Settings was a sibling row in the
	nav and Logout did not exist at all — the endpoint did (`POST /logout`),
	with nothing in the interface reaching it.

	Two things worth knowing.

	**Logout is a form post, not a link.** `POST /logout` deletes the session
	server-side; a GET would make signing somebody out something a prefetch or an
	`<img>` could do to them.

	**It ends the session at both ends.** `POST /logout` also sends the browser
	to the provider's `end_session_endpoint` (see `routes/logout/+server.ts`), so
	the directory's own session goes too — without that half, the next visit
	re-authenticates silently and signing out looks like it did nothing.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { onDestroy } from "svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { switchTheme, subscribeToTheme } from "$lib/switchTheme";
	import { browser } from "$app/environment";
	import { isPro } from "$lib/stores/isPro";
	import IconPro from "$lib/components/icons/IconPro.svelte";
	import IconSun from "$lib/components/icons/IconSun.svelte";
	import IconMoon from "$lib/components/icons/IconMoon.svelte";
	import CarbonSettings from "~icons/carbon/settings";
	import CarbonLogout from "~icons/carbon/logout";
	import CarbonUser from "~icons/carbon/user";
	import CarbonBook from "~icons/carbon/book";
	import CarbonChevronUp from "~icons/carbon/chevron-up";

	interface Props {
		/** `null` as well as `undefined`: that is what the layout's `user` is. */
		user: { username?: string; email?: string; avatarUrl?: string } | null | undefined;
		/** The gateway's answer (`GET /v1/me`), not the chat's own flag — the
		 * admin panel's gate is the gateway's, so the link shows only for the
		 * people that same answer admits. Absent for signed-out visitors. */
		gatewayIsAdmin?: boolean;
		/** Called when a menu item navigates, so a narrow layout can close the panel. */
		onnavigate?: () => void;
	}

	let { user, gatewayIsAdmin = false, onnavigate }: Props = $props();

	const publicConfig = usePublicConfig();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	const label = $derived(user?.username || user?.email || "Account");
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

	function onwindowclick(event: MouseEvent) {
		if (!open || !root) return;
		if (!root.contains(event.target as Node)) open = false;
	}

	function onwindowkeydown(event: KeyboardEvent) {
		if (event.key === "Escape" && open) open = false;
	}

	function go() {
		open = false;
		onnavigate?.();
	}
</script>

<svelte:window onclick={onwindowclick} onkeydown={onwindowkeydown} />

<div bind:this={root} class="relative">
	{#if open}
		<!-- Above the button, hence `bottom-full`: this sits at the foot of the
		     panel and a menu opening downward would be off-screen. -->
		<div
			class="absolute bottom-full left-0 z-30 mb-1 w-full min-w-52 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800"
			role="menu"
		>
			{#if publicConfig.isHuggingChat && user?.username}
				<a
					href="https://huggingface.co/{user.username}"
					target="_blank"
					rel="noopener noreferrer"
					onclick={go}
					role="menuitem"
					class="flex h-9 items-center gap-2 px-3 text-sm text-gray-700 no-underline hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					<CarbonUser class="size-4" />
					Your profile
				</a>
			{/if}

			<a
				href="{base}/settings/application"
				onclick={go}
				role="menuitem"
				class="flex h-9 items-center gap-2 px-3 text-sm text-gray-700 no-underline hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
			>
				<CarbonSettings class="size-4" />
				Settings
			</a>

			{#if gatewayIsAdmin}
				<!-- The chat's administration area (product decisions: which model
				     reads a document, what fetches a URL, which connectors everybody
				     gets). The panel's own gate re-asks the gateway; the link merely
				     spares an administrator the URL. -->
				<a
					href="{base}/admin"
					onclick={go}
					role="menuitem"
					class="flex h-9 items-center gap-2 px-3 text-sm text-gray-700 no-underline hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					<CarbonBook class="size-4" />
					Admin
				</a>
			{/if}

			<button
				type="button"
				onclick={() => {
					switchTheme();
				}}
				role="menuitem"
				class="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
			>
				{#if browser && isDark}
					<IconSun classNames="size-4" />
					Light theme
				{:else}
					<IconMoon classNames="size-4" />
					Dark theme
				{/if}
			</button>

			{#if publicConfig.isHuggingChat && $isPro === false}
				<a
					href="https://huggingface.co/subscribe/pro?from=HuggingChat"
					target="_blank"
					rel="noopener noreferrer"
					onclick={go}
					role="menuitem"
					class="flex h-9 items-center gap-2 px-3 text-sm text-gray-700 no-underline hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					<IconPro />
					Get PRO
				</a>
			{/if}

			<div class="border-t border-gray-200 dark:border-gray-600">
				<!-- A form post, not a link: signing somebody out must not be
				     something a prefetch can do to them. -->
				<!-- And the handler must not close this menu: `go` sets `open =
				     false`, which unmounts the form **while the browser is still
				     submitting it** — Chromium drops the submission of a form
				     detached during the submit event, so Sign out closed the menu
				     and did nothing else. The navigation the post produces takes
				     the whole page away; there is no menu left to close. -->
				<form method="POST" action="{base}/logout" onsubmit={() => onnavigate?.()}>
					<button
						type="submit"
						role="menuitem"
						class="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
					>
						<CarbonLogout class="size-4" />
						Sign out
					</button>
				</form>
			</div>
		</div>
	{/if}

	<button
		type="button"
		onclick={(event) => {
			event.stopPropagation();
			open = !open;
		}}
		aria-expanded={open}
		aria-haspopup="menu"
		class="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
	>
		{#if publicConfig.isHuggingChat && user?.username}
			<img
				src="https://huggingface.co/api/users/{user.username}/avatar?redirect=true"
				class="size-6 shrink-0 rounded-full border bg-gray-500 dark:border-white/40"
				alt=""
			/>
		{:else}
			<span
				class="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[0.6rem] font-semibold text-white"
			>
				{initials}
			</span>
		{/if}
		<span class="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{label}</span>
		{#if publicConfig.isHuggingChat && $isPro === true}
			<span class="shrink-0 text-gray-400"><IconPro /></span>
		{/if}
		<CarbonChevronUp class="size-3.5 shrink-0 text-gray-400 {open ? '' : 'rotate-180'}" />
	</button>
</div>
