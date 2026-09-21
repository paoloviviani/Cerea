<script lang="ts">
	import { onMount } from "svelte";
	import Logo from "$lib/components/icons/Logo.svelte";
	import type { Model } from "$lib/types/Model";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		currentModel: Model;
		onmessage?: (content: string) => void;
		children?: import("svelte").Snippet;
	}

	let { currentModel: _currentModel, onmessage, children }: Props = $props();

	$effect(() => {
		// referenced to appease linter while UI blocks are commented out
		void _currentModel;
		void onmessage;
	});

	/**
	 * Rotating phrases beside the app name on the new-chat screen — Turin
	 * dialect greetings, one per page load (PUBLIC_TURIN_PHRASES, "false" or
	 * empty restores the plain name). The parse tolerates the ways an env
	 * value can arrive: a quoted comma-separated list, a JSON array, or a
	 * single phrase with no separators at all.
	 */
	const phrases: string[] = (() => {
		const raw = publicConfig.PUBLIC_TURIN_PHRASES?.trim();
		if (!raw || raw.toLowerCase() === "false") return [];
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
	// page load remounts) gets a new one.
	let phrase = $state("");
	onMount(() => {
		if (phrases.length > 0) {
			phrase = phrases[Math.floor(Math.random() * phrases.length)] ?? "";
		}
	});
</script>

<div
	class="my-auto grid -translate-y-16 items-center justify-center gap-8 text-center md:-translate-y-12"
>
	<div
		class="flex items-center justify-center rounded-xl text-[1.6rem] font-semibold select-none md:text-[2.55rem]"
	>
		<Logo classNames="size-[2.55rem] md:size-[4.25rem] dark:invert mr-0.5" />
		{publicConfig.PUBLIC_APP_NAME}
		{#if phrase}
			<!-- Deliberately quieter than the name: smaller, gray, no weight — a
			     spoken aside, not a second title. -->
			<span class="ml-3 text-base font-normal text-gray-400 md:text-xl dark:text-gray-500">
				{phrase}
			</span>
		{/if}
	</div>
	{@render children?.()}
	<!-- <div class="lg:col-span-1">
		<div>
			<div class="mb-3 flex items-center text-2xl font-semibold">
				<Logo classNames="mr-1 flex-none dark:invert" />
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
