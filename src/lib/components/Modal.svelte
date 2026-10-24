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
		/** Below `sm` the dialog sits on the bottom edge as a sheet; from `sm` up it is centred as ever. */
		sheet?: boolean;
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
		sheet = false,
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

	// Whatever had focus when the dialog opened gets it back on close, so a
	// keyboard user lands on the control that opened it.
	let opener: HTMLElement | null = null;

	onMount(() => {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
		if (opener?.isConnected) opener.focus();
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
		class="fixed inset-0 z-40 flex justify-center bg-black/80 {sheet
			? 'items-end sm:items-center'
			: 'items-center'} backdrop-blur-xs dark:bg-black/50"
	>
		{#if disableFly}
			<div
				role="dialog"
				tabindex="-1"
				aria-labelledby={labelledBy}
				bind:this={modalEl}
				onkeydown={handleKeydown}
				class={[
					"relative mx-auto scrollbar-custom max-h-[95dvh] overflow-x-hidden overflow-y-auto bg-white shadow-2xl outline-hidden dark:bg-gray-800 dark:text-gray-200 dark:ring-1 dark:ring-white/15",
					sheet
						? "max-sm:w-full max-sm:max-w-none max-sm:rounded-t-2xl sm:max-w-[90dvw] sm:rounded-2xl"
						: "max-w-[90dvw] rounded-2xl",
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
					"relative mx-auto scrollbar-custom max-h-[95dvh] overflow-x-hidden overflow-y-auto bg-white shadow-2xl outline-hidden dark:bg-gray-800 dark:text-gray-200 dark:ring-1 dark:ring-white/15",
					sheet
						? "max-sm:w-full max-sm:max-w-none max-sm:rounded-t-2xl sm:max-w-[90dvw] sm:rounded-2xl"
						: "max-w-[90dvw] rounded-2xl",
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
