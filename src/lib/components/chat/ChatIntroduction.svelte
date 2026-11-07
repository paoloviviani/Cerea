<script lang="ts">
	import { onMount } from "svelte";
	import Logo from "$lib/components/icons/Logo.svelte";
	import type { Model } from "$lib/types/Model";
	import { m } from "$lib/paraglide/messages";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		currentModel: Model;
		onmessage?: (content: string) => void;
		/**
		 * The user's first name, when known. The subline greets them by it; with
		 * none, it greets everyone alike.
		 */
		firstName?: string;
		/**
		 * A starter chip was picked. `send: false` means the text is a beginning
		 * ("Help me plan ") that belongs in the composer for the user to finish.
		 */
		onstarter?: (text: string, send: boolean) => void;
		/** Show the starter chips (an administrator's switch, off by default). */
		showStarters?: boolean;
		children?: import("svelte").Snippet;
	}

	let {
		currentModel: _currentModel,
		onmessage,
		firstName = "",
		showStarters = false,
		onstarter,
		children,
	}: Props = $props();

	$effect(() => {
		// referenced to appease linter while UI blocks are commented out
		void _currentModel;
		void onmessage;
	});

	/**
	 * Rotating phrases printed in place of the app name on the new-chat
	 * screen — Turin dialect greetings, one per page load
	 * (PUBLIC_TURIN_PHRASES, "false" or empty restores the plain name
	 * every time). The parse tolerates the ways an env value can arrive: a
	 * quoted comma-separated list, a JSON array, or a single phrase with no
	 * separators at all.
	 */
	const phrases: string[] = (() => {
		const rawRaw = publicConfig.PUBLIC_TURIN_PHRASES?.trim();
		if (!rawRaw || rawRaw.toLowerCase() === "false") return [];
		// One matching pair of wrapping quotes comes off: dotenv strips them
		// on the path through .env.local, but a value set directly in a
		// compose `environment:` entry keeps them, and the first and last
		// phrase would otherwise carry a stray quote into the logo.
		const wrapped = rawRaw.length > 1 && (rawRaw.startsWith('"') || rawRaw.startsWith("'"));
		const raw = wrapped && rawRaw[rawRaw.length - 1] === rawRaw[0] ? rawRaw.slice(1, -1) : rawRaw;
		const list = raw.startsWith("[")
			? // JSON form: invalid JSON here means the deployment misconfigured
				// the variable, and the plain name is the right degradation.
				(() => {
					try {
						return JSON.parse(raw) as unknown;
					} catch {
						return [];
					}
				})()
			: raw.split(",");
		if (!Array.isArray(list)) return [];
		const trimmed = list
			.map((phrase) => (typeof phrase === "string" ? phrase.trim() : ""))
			.filter(Boolean);
		return trimmed;
	})();

	// Picked after hydration, not in the script body: the script runs on the
	// server too, and a Math.random() there would render one phrase in the
	// SSR payload and (usually) another after hydration — a mismatch warning
	// on every load. onMount is client-only, so the first paint carries the
	// plain name and the phrase lands right after; every refresh (a full
	// page load remounts) gets a new one. The name itself leads the
	// rotation: it is one of the things the logo says, not a bystander, and
	// it keeps the slot rendered even for a deployment with phrases off.
	const starters = [
		{
			id: "draft",
			label: m["chat.intro.starter.draft.label"](),
			prompt: m["chat.intro.starter.draft.prompt"](),
			send: false,
		},
		{
			id: "analyse",
			label: m["chat.intro.starter.analyse.label"](),
			prompt: m["chat.intro.starter.analyse.prompt"](),
			send: false,
		},
		{
			id: "plan",
			label: m["chat.intro.starter.plan.label"](),
			prompt: m["chat.intro.starter.plan.prompt"](),
			send: false,
		},
		{
			id: "cerea",
			label: m["chat.intro.starter.cerea.label"](),
			prompt: m["chat.intro.starter.cerea.prompt"](),
			send: true,
		},
	];

	let phrase = $state("");

	// What each built-in greeting means, for a user who has never met it. A phrase an
	// operator adds has no gloss here and is printed plain.
	const glosses: Record<string, () => string> = {
		"com'è?": () => m["chat.intro.gloss.how_is_it"](),
		"va bin": () => m["chat.intro.gloss.all_good"](),
		"facciamo che iniziare?": () => m["chat.intro.gloss.shall_we"](),
		"fuma c'anduma": () => m["chat.intro.gloss.lets_go"](),
	};
	let gloss = $derived(glosses[phrase.toLowerCase()]?.() ?? "");
	// A touch screen has no hover: a tap shows the gloss under the greeting.
	let glossOpen = $state(false);
	onMount(() => {
		const rotation = [publicConfig.PUBLIC_APP_NAME, ...phrases];
		phrase = rotation[Math.floor(Math.random() * rotation.length)] ?? "";
	});
</script>

<div
	class="my-auto grid -translate-y-16 items-center justify-center gap-8 text-center md:-translate-y-12"
>
	<div
		class="flex items-center justify-center rounded-xl text-[1.6rem] font-semibold select-none md:text-[2.55rem]"
	>
		<Logo classNames="h-[2.25rem] md:h-[3.25rem] w-auto mr-3" />
		<!-- The picked phrase REPLACES the name, in the name's own type: it
		     says Cerea, Com'è?, Va bin — not a name with a whisper beside
		     it. Empty until onMount picks, so the SSR payload (pinned by
		     the SSR test) carries the name only. -->
		{#if phrase && gloss}
			<span>
				<button
					type="button"
					class="cursor-help font-[inherit] underline decoration-dotted decoration-1 underline-offset-8 select-none"
					title={gloss}
					aria-label="{phrase} — {gloss}"
					data-testid="intro-phrase"
					onclick={() => (glossOpen = !glossOpen)}
					onblur={() => (glossOpen = false)}
				>
					{phrase}
				</button>
			</span>
		{:else if phrase}
			{phrase}
		{:else}
			{publicConfig.PUBLIC_APP_NAME}
		{/if}
	</div>
	{#if glossOpen}
		<span role="status" class="-mt-5 text-sm text-ink-muted" data-testid="intro-gloss">
			{gloss}
		</span>
	{/if}
	<!-- The plain line under the greeting: the phrase may be Piedmontese, this
	     is the sentence that says what the page is for. -->
	<p class="-mt-5 text-base text-ink-muted" data-testid="intro-subline">
		{firstName ? m["chat.intro.subline_named"]({ name: firstName }) : m["chat.intro.subline"]()}
	</p>
	{#if showStarters}
		<ul
			class="flex flex-wrap items-center justify-center gap-2"
			aria-label={m["chat.intro.starters_label"]()}
		>
			{#each starters as starter (starter.id)}
				<li>
					<button
						type="button"
						data-testid="starter-{starter.id}"
						class="rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
						onclick={() => onstarter?.(starter.prompt, starter.send)}
					>
						{starter.label}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{@render children?.()}
	<!-- <div class="lg:col-span-1">
		<div>
			<div class="mb-3 flex items-center text-2xl font-semibold">
				<Logo classNames="mr-1 flex-none h-7 w-auto" />
				{publicConfig.PUBLIC_APP_NAME}
				<div
					class="ml-3 flex h-6 items-center rounded-lg border border-gray-100 bg-gray-50 px-2 text-base text-gray-400 dark:border-gray-700/60 dark:bg-gray-800"
				>
					{publicConfig.PUBLIC_VERSION}
				</div>
			</div>
			<p class="text-base text-gray-600 dark:text-gray-400">
				{publicConfig.PUBLIC_APP_DESCRIPTION ||
					"Making the community's best AI chat models available to everyone."}
			</p>
		</div>
	</div>
	<div class="lg:col-span-2 lg:pl-24">
		{#each JSON5.parse(publicConfig.PUBLIC_ANNOUNCEMENT_BANNERS || "[]") as banner}
			<AnnouncementBanner classNames="mb-4" title={banner.title}>
				<a
					target={banner.external ? "_blank" : "_self"}
					href={banner.linkHref}
					class="mr-2 flex items-center underline hover:no-underline">{banner.linkTitle}</a
				>
			</AnnouncementBanner>
		{/each}
		<div class="overflow-hidden rounded-xl border dark:border-gray-800">
			<div class="flex p-3">
				<div>
					<div class="text-sm text-gray-600 dark:text-gray-400">Current Model</div>
					<div class="flex items-center gap-1.5 font-semibold max-sm:text-smd">
						{#if currentModel.logoUrl}
							<img
								class="aspect-square size-4 rounded-sm border bg-white dark:border-gray-700"
								src={currentModel.logoUrl}
								alt=""
							/>
						{:else}
							<div
								class="size-4 rounded-sm border border-transparent bg-gray-300 dark:bg-gray-800"
							></div>
						{/if}
						{currentModel.displayName}
					</div>
				</div>
				<button
					type="button"
					onclick={() => goto(`/workspace?tab=models&id=${currentModel.id}`)}
					aria-label="Settings"
					class="btn ml-auto flex h-7 w-7 self-start rounded-full bg-gray-100 p-1 text-xs hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-600"
					><IconGear /></button
				>
			</div>
			<ModelCardMetadata variant="dark" model={currentModel} />
		</div>
	</div>
	<div class="h-40 sm:h-24"></div> -->
</div>
