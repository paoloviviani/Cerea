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
	import { m } from "$lib/paraglide/messages";
	import { base } from "$app/paths";
	import IconBook from "~icons/carbon/book";
	import IconDataBase from "~icons/carbon/data-base";
	import IconDocument from "~icons/carbon/document";
	import IconMicrophone from "~icons/carbon/microphone";
	import IconLaunch from "~icons/carbon/launch";
	import IconPlug from "~icons/carbon/plug";
	import IconBot from "~icons/lucide/bot";
	import IconSearch from "~icons/carbon/search";
	import SectionSwitcher from "$lib/components/nav/SectionSwitcher.svelte";
	import type { LayoutServerData } from "./$types";

	let { data, children }: { data: LayoutServerData; children: import("svelte").Snippet } = $props();

	// Only what exists. A tab leading to a 404 is
	// worse than a tab that is not there. The Knowledge section hides when the
	// deployment switch says the pipeline is off (FeatureFlags.knowledgeEnabled,
	// on unless explicitly "false") — /admin itself redirects to the first
	// section that exists, so nothing lands on the missing one.
	const sections = $derived([
		...((page.data as { knowledgeEnabled?: boolean }).knowledgeEnabled !== false
			? [{ href: "/admin/knowledge", label: m["admin.layout.section.knowledge"](), icon: IconBook }]
			: []),
		{ href: "/admin/web-search", label: m["admin.layout.section.web_search"](), icon: IconSearch },
		{ href: "/admin/fetch", label: m["admin.layout.section.fetching"](), icon: IconDocument },
		{ href: "/admin/connectors", label: m["admin.layout.section.connectors"](), icon: IconPlug },
		{ href: "/admin/skills", label: m["admin.layout.section.skills"](), icon: IconDocument },
		{ href: "/admin/voice", label: m["admin.layout.section.voice"](), icon: IconMicrophone },
		{
			href: "/admin/instructions",
			label: m["admin.layout.section.instructions"](),
			icon: IconDocument,
		},
		{ href: "/admin/delegation", label: m["admin.layout.section.sub_agents"](), icon: IconBot },
		{ href: "/admin/storage", label: m["admin.layout.section.storage"](), icon: IconDataBase },
	]);

	const current = $derived(page.url.pathname);
	const switcherSections = $derived(sections.map((s) => ({ ...s, href: `${base}${s.href}` })));
	const currentSection = $derived(
		switcherSections.find((s) => current.startsWith(s.href))?.href ?? ""
	);
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
		<h1 class="text-xl font-semibold">{m["admin.layout.title"]()}</h1>
		{#if !data.signedIn}
			<p class="text-sm text-gray-600 dark:text-gray-400">{m["admin.layout.not_signed_in"]()}</p>
		{:else if data.identity}
			<!-- The gateway answered and said no. Said plainly, because this is
			     the common case and it is not an error. -->
			<div
				class="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-800"
			>
				<p class="font-medium">{m["admin.layout.denied.title"]()}</p>
				<p class="mt-1 text-gray-600 dark:text-gray-400">
					{m["admin.layout.denied.body"]({
						who: data.identity.email ?? m["admin.layout.denied.yourself"](),
					})}
				</p>
			</div>
		{:else}
			<!-- Two different problems, said apart. A bare 403 would send somebody
			     to ask for a permission they may already have. -->
			<div
				class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
			>
				<p class="font-medium">{m["admin.layout.needs_admin.title"]()}</p>
				<p class="mt-1">
					{m["admin.layout.needs_admin.body"]()}
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
			<h1 class="text-xl font-semibold">{m["admin.layout.title"]()}</h1>
			<SectionSwitcher
				label={m["admin.layout.sections_label"]()}
				sections={switcherSections}
				current={currentSection}
			/>
			{#if (page.data as { consoleEnabled?: boolean }).consoleEnabled}
				<!-- Not a section of this panel but a way out of it: the platform
				     side — providers, models, prices, quotas, users — lives in the
				     Pystino console, same origin. A link, deliberately styled
				     unlike the tabs below so nobody expects a panel to open under
				     it; the split is by whose decision it is (the file header),
				     not by which service stores the data. Gated on the deployment
				     flag (FeatureFlags.consoleEnabled, CHAT_CONSOLE_ENABLED): a
				     standalone profile's origin does not serve /console —
				     satellite's is central's, generic has none — and a link to
				     an unserved path would be a 404 wearing a feature's name. -->
				<a
					href="/console"
					class="inline-flex w-fit items-center gap-1.5 text-sm text-blue-600 hover:underline dark:text-blue-400"
				>
					<IconLaunch class="size-4" />
					{m["admin.layout.console_link"]()}
				</a>
			{/if}
		</header>

		<nav
			aria-label={m["admin.layout.sections_label"]()}
			class="hidden flex-wrap gap-0.5 border-b border-gray-200 sm:gap-1 md:flex dark:border-gray-700"
		>
			{#each sections as section (section.href)}
				{@const active = current.startsWith(`${base}${section.href}`)}
				<a
					href="{base}{section.href}"
					class="flex items-center gap-1 rounded-t-lg border-b-2 px-2 py-1.5 text-xs font-medium transition-colors sm:gap-1.5 sm:px-3 sm:py-2 sm:text-sm {active
						? 'border-blue-600 text-blue-700 dark:text-blue-400'
						: 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
				>
					<section.icon class="size-3.5 sm:size-4" />
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
