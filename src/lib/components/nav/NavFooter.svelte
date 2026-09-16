<!--
	The footer: the person, and the two things they can do from here — flip the
	theme, sign out.

	Static by design. This replaced `UserMenu`, whose every affordance lived
	behind a popup that opened upward from the foot of the panel; what its menu
	offered is now rows of the panel itself (Settings, Admin) or inline here.
	Nothing in this row opens a menu, so there is no outside-click handling, no
	Escape handling and no `aria-haspopup`.

	Two things carried over from the menu, because they are about the endpoint
	rather than the control:

	**Logout is a form post, not a link.** `POST /logout` deletes the session
	server-side; a GET would make signing somebody out something a prefetch or
	an `<img>` could do to them.

	**It ends the session at both ends.** `POST /logout` also sends the browser
	to the provider's `end_session_endpoint` (see `routes/logout/+server.ts`), so
	the directory's own session goes too — without that half, the next visit
	re-authenticates silently and signing out looks like it did nothing.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { onDestroy } from "svelte";
	import { browser } from "$app/environment";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { switchTheme, subscribeToTheme } from "$lib/switchTheme";
	import IconSun from "$lib/components/icons/IconSun.svelte";
	import IconMoon from "$lib/components/icons/IconMoon.svelte";
	import CarbonLogout from "~icons/carbon/logout";

	interface Props {
		/** `null` as well as `undefined`: that is what the layout's `user` is. */
		user: { username?: string; email?: string; avatarUrl?: string } | null | undefined;
	}

	let { user }: Props = $props();

	const publicConfig = usePublicConfig();

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

	const GHOST =
		"grid size-7 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300";
</script>

<div class="flex h-10 items-center gap-1.5 rounded-lg px-2">
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

	<button
		type="button"
		onclick={switchTheme}
		aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
		title={isDark ? "Light theme" : "Dark theme"}
		class={GHOST}
	>
		{#if browser && isDark}
			<IconSun classNames="size-4" />
		{:else}
			<IconMoon classNames="size-4" />
		{/if}
	</button>

	<!-- A form post, not a link: signing somebody out must not be something a
	     prefetch can do to them. -->
	<form method="POST" action="{base}/logout" class="flex">
		<button
			type="submit"
			aria-label="Sign out"
			title="Sign out"
			class="{GHOST} hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
		>
			<CarbonLogout class="size-4" />
		</button>
	</form>
</div>
