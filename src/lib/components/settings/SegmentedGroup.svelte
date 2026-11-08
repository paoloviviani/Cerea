<script lang="ts">
	interface Option {
		value: string;
		label: string;
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

	/** The radio-group keyboard pattern (as SwatchGroup): arrows move choice and focus together. */
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

<div
	role="radiogroup"
	aria-label={label}
	class="inline-flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700"
>
	{#each options as option, index (option.value)}
		{@const checked = option.value === value}
		<button
			bind:this={buttons[index]}
			type="button"
			role="radio"
			aria-checked={checked}
			tabindex={index === selectedIndex ? 0 : -1}
			onclick={() => onchange(option.value)}
			onkeydown={(event) => onKeydown(event, index)}
			class="rounded-md px-3 py-1 text-[13px] focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:outline-hidden dark:focus-visible:ring-gray-100
				{checked
				? 'bg-white font-medium text-gray-900 shadow-xs dark:bg-gray-500 dark:text-white'
				: 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'}"
		>
			{option.label}
		</button>
	{/each}
</div>
