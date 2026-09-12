<script lang="ts">
	import { onMount, tick } from "svelte";
	import { base } from "$app/paths";
	import { afterNavigate, goto } from "$app/navigation";
	import { page } from "$app/state";
	import { useSettingsStore } from "$lib/stores/settings";
	import IconBurger from "$lib/components/icons/IconBurger.svelte";
	import CarbonClose from "~icons/carbon/close";
	import CarbonChevronLeft from "~icons/carbon/chevron-left";
	import IconGear from "~icons/bi/gear-fill";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	import type { LayoutData } from "../$types";
	import { browser } from "$app/environment";
	import { isDesktop } from "$lib/utils/isDesktop";
	import { debounce } from "$lib/utils/debounce";

	interface Props {
		data: LayoutData;
		children?: import("svelte").Snippet;
	}

	let { data, children }: Props = $props();

	let previousPage: string = $state(base || "/");
	let showContent: boolean = $state(false);


	function checkDesktopRedirect() {
		if (
			browser &&
			isDesktop(window) &&
			page.url.pathname === `${base}/settings` &&
			!page.url.pathname.endsWith("/application")
		) {
			goto(`${base}/settings/application`);
		}
	}

	onMount(() => {
		// Show content when not on the root settings page
		showContent = page.url.pathname !== `${base}/settings`;
		// Initial desktop redirect check
		checkDesktopRedirect();

		// Add resize listener for desktop redirect
		if (browser) {
			const debouncedCheck = debounce(checkDesktopRedirect, 100);
			window.addEventListener("resize", debouncedCheck);
			return () => window.removeEventListener("resize", debouncedCheck);
		}
	});

	afterNavigate(({ from }) => {
		if (from?.url && !from.url.pathname.includes("settings")) {
			previousPage = from.url.toString() || previousPage || base || "/";
		}
		// Show content when not on the root settings page
		showContent = page.url.pathname !== `${base}/settings`;
		// Check desktop redirect after navigation
		checkDesktopRedirect();

	});

</script>

<div
	class="mx-auto grid h-full w-full max-w-[1400px] grid-cols-1 grid-rows-[auto_1fr] content-start gap-x-6 overflow-hidden p-4 text-gray-800 md:grid-cols-3 md:grid-rows-[auto_1fr] md:p-4 dark:text-gray-300"
>
	<div class="col-span-1 mb-3 flex items-center justify-between md:col-span-3 md:mb-4">
		{#if showContent && browser}
			<button
				class="btn rounded-lg md:hidden"
				aria-label="Back to menu"
				onclick={() => {
					showContent = false;
					goto(`${base}/settings`);
				}}
			>
				<IconBurger
					classNames="text-xl text-gray-900 hover:text-black dark:text-gray-200 dark:hover:text-white sm:hidden"
				/>
				<CarbonChevronLeft
					class="text-xl text-gray-900 hover:text-black max-sm:hidden dark:text-gray-200 dark:hover:text-white"
				/>
			</button>
		{/if}
		<h2 class=" right-0 left-0 mx-auto w-fit text-center text-xl font-bold md:hidden">Settings</h2>
		<button
			class="btn rounded-lg"
			aria-label="Close settings"
			onclick={() => {
				goto(previousPage);
			}}
		>
			<CarbonClose
				class="text-xl text-gray-900 hover:text-black dark:text-gray-200 dark:hover:text-white"
			/>
		</button>
	</div>
	{#if !(showContent && browser && !isDesktop(window))}
		<div
			class="col-span-1 scrollbar-custom flex flex-col overflow-y-auto rounded-r-xl bg-linear-to-l from-gray-50 to-10% whitespace-nowrap max-md:-mx-4 max-md:h-full md:pr-6 dark:from-gray-700/40"
			class:max-md:hidden={showContent && browser}
		>
			<!-- Section Headers -->
			<!-- A second section, not an entry appended to the first.
			     "Application Settings" sat directly under the model list with the
			     same shape as a model row, so the panel read as one list whose
			     last item happened to be a gear. These are different kinds of
			     thing — one picks a model, the other configures the client — and
			     a heading is what says so. The wrapper carries the sticky and
			     mobile-ordering behaviour the button had, so the heading travels
			     with it instead of being stranded at the bottom on a phone. -->
			<div class="sticky bottom-0 mt-2 flex flex-col bg-white max-md:order-first dark:bg-gray-800">
				<h3
					class="border-t border-gray-200 px-3 pt-3 pb-1 text-xs font-semibold text-gray-600 md:text-left dark:border-gray-700 dark:text-gray-400"
				>
					Application
				</h3>
				<button
					type="button"
					onclick={() => goto(`${base}/settings/application`)}
					class="group mb-1 flex h-9 w-full flex-none items-center gap-1 rounded-lg px-3 text-[13px] text-gray-600 md:rounded-xl md:px-3 dark:text-gray-300 {page
						.url.pathname === `${base}/settings/application`
						? 'bg-gray-100! text-gray-800! dark:bg-gray-700! dark:text-gray-200!'
						: 'hover:bg-gray-100 dark:hover:bg-gray-700'}"
					aria-label="Configure application settings"
				>
					<IconGear class="mr-0.5 text-xxs" />
					Application Settings
				</button>
			</div>
		</div>
	{/if}
	{#if showContent}
		<div
			class="col-span-1 scrollbar-custom w-full overflow-x-clip overflow-y-auto px-1 md:col-span-2 md:row-span-2"
			class:max-md:hidden={!showContent && browser}
		>
			{@render children?.()}
		</div>
	{/if}
</div>
