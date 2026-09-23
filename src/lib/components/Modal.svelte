<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { cubicOut } from "svelte/easing";
	import { fade, fly } from "svelte/transition";
	import Portal from "./Portal.svelte";
	import { browser } from "$app/environment";
	import CarbonClose from "~icons/carbon/close";
	import { tap } from "$lib/utils/haptics";

	interface Props {
		width?: string;
		closeButton?: boolean;
		disableFly?: boolean;
		/** When false, clicking backdrop will not close the modal */
		closeOnBackdrop?: boolean;
		/** id of the element naming the dialog, typically its heading */
		labelledBy?: string;
		onclose?: () => void;
		children?: import("svelte").Snippet;
	}

	let {
		width = "max-w-sm",
		children,
		closeButton = false,
		disableFly = false,
		closeOnBackdrop = true,
		labelledBy,
		onclose,
	}: Props = $props();

	let backdropEl: HTMLDivElement | undefined = $state();
	let modalEl: HTMLDivElement | undefined = $state();

	function handleKeydown(event: KeyboardEvent) {
		// close on ESC
		if (event.key === "Escape") {
			event.preventDefault();
			onclose?.();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (window?.getSelection()?.toString()) {
			return;
		}
		if (event.target === backdropEl && closeOnBackdrop) {
			onclose?.();
		}
	}

	onMount(() => {
		document.getElementById("app")?.setAttribute("inert", "true");
		modalEl?.focus();
		tap();
		// Ensure Escape closes even if focus isn't within modal
		window.addEventListener("keydown", handleKeydown, { capture: true });
	});

	onDestroy(() => {
		if (!browser) return;
		document.getElementById("app")?.removeAttribute("inert");
		window.removeEventListener("keydown", handleKeydown, { capture: true });
	});
</script>

<Portal>
	<div
		role="presentation"
		tabindex="-1"
		bind:this={backdropEl}
		onclick={(e) => {
			e.stopPropagation();
			handleBackdropClick(e);
		}}
		transition:fade|local={{ easing: cubicOut, duration: 300 }}
		class="fixed inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-xs dark:bg-black/50"
	>
		{#if disableFly}
			<div
				role="dialog"
				tabindex="-1"
				aria-labelledby={labelledBy}
				bind:this={modalEl}
				onkeydown={handleKeydown}
				class={[
					"dialog-shell relative mx-auto scrollbar-custom max-w-[90dvw] overflow-x-hidden overflow-y-auto rounded-2xl bg-white shadow-2xl outline-hidden dark:bg-gray-800 dark:text-gray-200 dark:ring-1 dark:ring-white/15",
					width,
				]}
			>
				{#if closeButton}
					<button class="absolute top-4 right-4 z-50" onclick={() => onclose?.()}>
						<CarbonClose class="size-6 text-gray-700 dark:text-gray-300" />
					</button>
				{/if}
				{@render children?.()}
			</div>
		{:else}
			<div
				role="dialog"
				tabindex="-1"
				aria-labelledby={labelledBy}
				bind:this={modalEl}
				onkeydown={handleKeydown}
				in:fly={{ y: 100 }}
				class={[
					"dialog-shell relative mx-auto scrollbar-custom max-w-[90dvw] overflow-x-hidden overflow-y-auto rounded-2xl bg-white shadow-2xl outline-hidden dark:bg-gray-800 dark:text-gray-200 dark:ring-1 dark:ring-white/15",
					width,
				]}
			>
				{#if closeButton}
					<button class="absolute top-4 right-4 z-50" onclick={() => onclose?.()}>
						<CarbonClose class="size-6 text-gray-700 dark:text-gray-300" />
					</button>
				{/if}
				{@render children?.()}
			</div>
		{/if}
	</div>
</Portal>

<style>
	/* WebKit that predates dvh support (iOS/Safari < 15.4, and various
	   embedded WKWebViews) drops `max-height: 95dvh` as an invalid
	   declaration rather than clamping to it — max-height then resolves to
	   `none`, so the dialog can grow taller than the viewport with nothing
	   to stop it (the footer's Create/Cancel buttons scroll out of reach).
	   `95vh` first keeps every engine bounded; `95dvh` on the next line
	   overrides it only where the browser understands the unit, so engines
	   that support it still get the dynamic (toolbar-aware) viewport height
	   exactly as before. Plain unlayered CSS, so it wins over the `@layer
	   utilities` Tailwind classes on the same element regardless of source
	   order (see the `revert-layer` note in styles/main.css for the same
	   pattern already relied on here). */
	.dialog-shell {
		max-height: 95vh;
		max-height: 95dvh;
	}
</style>
