<!--
	User-facing application settings, as a main-screen page.

	Deliberately mirrors `routes/admin/+layout.svelte`: a centred frame with
	an `h1` title, a subtitle, a tab bar, and a scroll container — rather than
	the modal overlay this used to be. More tabs are entries in `sections`,
	the way the admin side does it.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { useSettingsStore } from "$lib/stores/settings";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonSettings from "~icons/carbon/settings";
	import CarbonMeter from "~icons/carbon/meter";

	interface Props {
		children?: import("svelte").Snippet;
	}

	let { children }: Props = $props();

	const settings = useSettingsStore();

	// Only what exists. A tab leading to a 404 is worse than a tab that is
	// not there — Usage & billing only appears once the deployment flag says
	// there is a provider behind it.
	const sections = $derived([
		{ href: "/settings/application", label: "Application settings", icon: CarbonSettings },
		// Gated on the deployment flag (FeatureFlags.usageEnabled, computed
		// server-side from CHAT_USAGE_ENABLED and OPENAI_BASE_URL): a
		// deployment without Pystino has no usage provider to show here.
		...(page.data.usageEnabled
			? [{ href: "/settings/usage", label: "Usage & billing", icon: CarbonMeter }]
			: []),
	]);

	const current = $derived(page.url.pathname);
</script>

<!--
	h-full and min-h-0 bound this frame to the row the root layout gives it:
	the root shell is `fixed h-dvh overflow-hidden` by design — the chat
	scrolls inside its own panes — so a frame that merely grew with its
	content was clipped at the window edge with no scrollbar anywhere, and
	on the phone-sized viewport of the installed PWA most of a page simply
	did not exist. min-h-0 is what stops this frame's own height from
	inflating the 1fr row back out to its content: without it the row (and
	so the clipping) returns, whatever h-full says.
-->
<div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">Settings</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">Personal preferences for this chat.</p>
	</header>

	<nav class="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
		{#each sections as section (section.href)}
			{@const active = current.startsWith(`${base}${section.href}`)}
			<a
				href="{base}{section.href}"
				class="flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors {active
					? 'border-blue-600 text-blue-700 dark:text-blue-400'
					: 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
			>
				<section.icon class="size-4" />
				{section.label}
			</a>
		{/each}
	</nav>

	<!--
		The page scrolls here, under the pinned tabs, not the window. It also
		gives every page a block-level parent again: as a direct flex item, a
		centered `mx-auto max-w-4xl` frame is sized fit-content, whose
		min-content floor is the width of the widest unbreakable row — and
		overflow-hidden would eat the difference. In a plain block the same
		classes are the ordinary "fill, cap at 4xl, centre" idiom.
	-->
	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
		{@render children?.()}
	</div>
</div>

{#if $settings.recentlySaved}
	<div
		class="fixed right-4 bottom-4 m-2 flex items-center gap-1.5 rounded-full border bg-black px-3 py-1 text-white dark:border-white/10 dark:bg-gray-700 dark:text-gray-100"
	>
		<CarbonCheckmark class="text-white" />
		Saved
	</div>
{/if}
