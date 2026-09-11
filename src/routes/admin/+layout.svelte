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
	import type { LayoutServerData } from "./$types";

	let { data, children }: { data: LayoutServerData; children: import("svelte").Snippet } = $props();

	// Only what exists. Connectors (site-wide MCP servers) and Published
	// (agents and knowledge bases shared with everyone) belong here and are not
	// built yet; a tab leading to a 404 is worse than a tab that is not there.
	const sections = [
		{ href: "/admin/knowledge", label: "Knowledge", icon: IconBook },
		{ href: "/admin/fetch", label: "Fetching", icon: IconDocument },
	];

	const current = $derived(page.url.pathname);
</script>

{#if !data.identity}
	<div class="mx-auto flex max-w-2xl flex-col gap-4 p-6">
		<h1 class="text-xl font-semibold">Administration</h1>
		{#if !data.signedIn}
			<p class="text-sm text-gray-600 dark:text-gray-400">You are not signed in.</p>
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
	<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
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

		{@render children()}
	</div>
{/if}
