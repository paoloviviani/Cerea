<script lang="ts">
	import { tap } from "$lib/utils/haptics";

	interface Props {
		checked: boolean;
		name: string;
		size?: "sm" | "md";
		disabled?: boolean;
	}

	let { checked = $bindable(), name, size = "md", disabled = false }: Props = $props();

	// Explicit class strings per size (Tailwind needs literal class names to scan).
	const trackClasses = $derived(
		size === "sm"
			? "h-3.5 w-6 p-0.5 peer-checked:[&>div]:translate-x-2.5"
			: "h-5 w-9 p-1 peer-checked:[&>div]:translate-x-3.5"
	);
	const thumbClasses = $derived(size === "sm" ? "h-2.5 w-2.5" : "h-3.5 w-3.5");

	function toggle() {
		if (disabled) return;
		checked = !checked;
		tap();
	}

	/**
	 * The visible control, not the hidden input, owns the click. Without this a
	 * switch nested in a `<label>` toggles twice per trusted click: once here,
	 * and once more when the label forwards its activation to the input — which
	 * nets to no change and reads as the switch being stuck. Cancelling the
	 * event's default stops the forwarded click; a click on the label's text
	 * still reaches the input and toggles once, as before.
	 */
	function onToggleClick(event: MouseEvent) {
		event.preventDefault();
		toggle();
	}

	function onKeydown(e: KeyboardEvent) {
		if (disabled) return;
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			toggle();
		}
	}
</script>

<input
	bind:checked
	{disabled}
	type="checkbox"
	{name}
	class="peer pointer-events-none absolute opacity-0"
/>
<div
	aria-checked={checked}
	aria-disabled={disabled}
	aria-roledescription="switch"
	aria-label="switch"
	role="switch"
	tabindex={disabled ? -1 : 0}
	onclick={onToggleClick}
	onkeydown={onKeydown}
	class="relative inline-flex shrink-0 items-center rounded-full bg-gray-300 shadow-inner ring-gray-400 peer-checked:bg-blue-600 focus-visible:ring-3 focus-visible:ring-offset-1 dark:bg-gray-600 dark:ring-gray-700 {trackClasses} {disabled
		? 'cursor-not-allowed opacity-50'
		: 'cursor-pointer hover:bg-gray-400 hover:peer-checked:bg-blue-600 dark:hover:bg-gray-500 dark:hover:peer-checked:bg-blue-600'}"
>
	<div class="rounded-full bg-white shadow-xs transition-transform {thumbClasses}"></div>
</div>
