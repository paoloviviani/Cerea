<script lang="ts">
	import CarbonCheckmark from "~icons/carbon/checkmark";

	interface Option {
		value: string;
		label: string;
		/** A fixed CSS colour: a swatch shows what it would paint, not the live theme. */
		colour: string;
	}

	interface Props {
		/** The group's accessible name. */
		label: string;
		options: Option[];
		value: string;
		onchange: (value: string) => void;
	}

	let { label, options, value, onchange }: Props = $props();

	let buttons = $state<HTMLButtonElement[]>([]);

	// An unknown stored value must not leave the group with no tab stop.
	const selectedIndex = $derived(
		Math.max(
			0,
			options.findIndex((o) => o.value === value)
		)
	);

	/**
	 * The radio-group keyboard pattern (WAI-ARIA APG): arrows move the choice
	 * and the focus together, Home/End jump to the ends, and only the chosen
	 * swatch is in the tab order.
	 */
	function onKeydown(event: KeyboardEvent, index: number) {
		const last = options.length - 1;
		let next: number;
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown":
				next = index === last ? 0 : index + 1;
				break;
			case "ArrowLeft":
			case "ArrowUp":
				next = index === 0 ? last : index - 1;
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = last;
				break;
			default:
				return;
		}
		event.preventDefault();
		buttons[next]?.focus();
		onchange(options[next].value);
	}
</script>

<div role="radiogroup" aria-label={label} class="flex flex-wrap items-center gap-2.5">
	{#each options as option, index (option.value)}
		{@const checked = option.value === value}
		<button
			bind:this={buttons[index]}
			type="button"
			role="radio"
			aria-checked={checked}
			aria-label={option.label}
			title={option.label}
			tabindex={index === selectedIndex ? 0 : -1}
			onclick={() => onchange(option.value)}
			onkeydown={(event) => onKeydown(event, index)}
			class="grid size-7 place-items-center rounded-full border border-black/10 text-white transition-shadow focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-hidden dark:border-white/20 dark:focus-visible:ring-gray-100 dark:focus-visible:ring-offset-gray-800
				{checked
				? 'ring-2 ring-gray-900 ring-offset-2 ring-offset-white dark:ring-gray-100 dark:ring-offset-gray-800'
				: 'hover:ring-2 hover:ring-gray-300 hover:ring-offset-2 hover:ring-offset-white dark:hover:ring-gray-600 dark:hover:ring-offset-gray-800'}"
			style:background-color={option.colour}
		>
			{#if checked}
				<!-- The mark, so the choice does not rest on the ring alone. -->
				<CarbonCheckmark class="size-4 drop-shadow-sm" aria-hidden="true" />
			{/if}
		</button>
	{/each}
</div>
