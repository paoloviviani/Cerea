<!--
	The chat's administration area.

	Separate from the Pystino console on purpose, and the split is by *whose
	decision it is* rather than by which service stores the data (ADR 0062). The
	console owns providers, models, prices, quotas, redaction and users — how the
	platform is run. This owns what the product does: which model reads a
	document, what fetches a URL, which connectors everybody gets, what is
	published to everyone. Several of those are gateway rows underneath; the
	decision is still a product one, and this is where it is made.

	Who may be here is the gateway's answer (`GET /v1/me`), never the chat's own
	`user.isAdmin`, which comes from a HuggingFace organisation claim and means
	nothing in this deployment.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import IconBook from "~icons/carbon/book";
	import IconDocument from "~icons/carbon/document";
	import IconPlug from "~icons/carbon/plug";
	import type { LayoutServerData } from "./$types";

	let { data, children }: { data: LayoutServerData; children: import("svelte").Snippet } = $props();

	// Only what exists. A tab leading to a 404 is
	// worse than a tab that is not there.
	const sections = [
		{ href: "/admin/knowledge", label: "Knowledge", icon: IconBook },
		{ href: "/admin/fetch", label: "Fetching", icon: IconDocument },
		{ href: "/admin/connectors", label: "Connectors", icon: IconPlug },
		{ href: "/admin/skills", label: "Skills", icon: IconDocument },
	];

	const current = $derived(page.url.pathname);
</script>

<!--
	`!isAdmin`, not `!identity`. The first version tested only whether the
	gateway answered at all, so a signed-in non-administrator was handed the
	whole panel and every button in it then 403'd — which is exactly the
	experience asking the gateway was supposed to prevent. Found by
	`scripts/test_admin_panel_live.py`, not by a unit test: the refusal depends
	on a real answer from a real gateway.
-->
{#if !data.identity?.isAdmin}
	<div class="mx-auto flex max-w-2xl flex-col gap-4 p-6">
		<h1 class="text-xl font-semibold">Administration</h1>
		{#if !data.signedIn}
			<p class="text-sm text-gray-600 dark:text-gray-400">You are not signed in.</p>
		{:else if data.identity}
			<!-- The gateway answered and said no. Said plainly, because this is
			     the common case and it is not an error. -->
			<div
				class="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-800"
			>
				<p class="font-medium">This area is for administrators.</p>
				<p class="mt-1 text-gray-600 dark:text-gray-400">
					You are signed in as {data.identity.email ?? "yourself"}, and this deployment's gateway
					does not list you as an administrator. Nothing here is hidden from you out of caution —
					these are settings that change the chat for everybody.
				</p>
			</div>
		{:else}
			<!-- Two different problems, said apart. A bare 403 would send somebody
			     to ask for a permission they may already have. -->
			<div
				class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				<p class="font-medium">This area needs an administrator.</p>
				<p class="mt-1">
					Either this deployment's gateway does not list you as one, or you signed in with a local
					password rather than through the identity provider — an administration decision needs
					evidence that a person just signed in, so a local session cannot reach here. Signing out
					and back in through the provider is the first thing to try.
				</p>
			</div>
		{/if}
	</div>
{:else}
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
			<h1 class="text-xl font-semibold">Administration</h1>
			<p class="text-sm text-gray-500 dark:text-gray-400">
				Site-wide settings for this chat. Signed in as {data.identity.email ??
					data.identity.displayName ??
					"an administrator"}.
			</p>
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
			min-content floor is the width of the widest unbreakable row — for
			knowledge's nowrap table that was 749px inside a 390px viewport, and
			overflow-hidden ate the difference. In a plain block the same classes
			are the ordinary "fill, cap at 4xl, centre" idiom.
		-->
		<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
			{@render children()}
		</div>
	</div>
{/if}
