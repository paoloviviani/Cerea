<!--
	The one ⋯ menu a row of the agents panel carries (machine, workspace,
	session): every action of the row, so the row itself shows none besides
	its link. The trigger keeps its slot in the row at all times and is only
	made transparent on a pointer that can hover (`.nav-reveal`, styled in
	CodeNavTree), so the row never shifts when it appears; on a touch screen
	it is always there and a 44px target. Open state is the caller's, so a
	long-press on the row can open the same menu.
-->
<script module lang="ts">
	const ITEM =
		"flex h-9 items-center gap-2 rounded-md px-2 text-sm select-none focus-visible:outline-hidden sm:h-8";
	/** An ordinary action. */
	export const MENU_ITEM = `${ITEM} text-gray-700 data-highlighted:bg-gray-100 dark:text-gray-200 dark:data-highlighted:bg-white/10`;
	/** A destructive one: last in its menu, in red. */
	export const MENU_ITEM_DANGER = `${ITEM} text-red-600 data-highlighted:bg-red-50 dark:text-red-400 dark:data-highlighted:bg-red-500/10`;
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { DropdownMenu } from "bits-ui";
	import IconKebab from "~icons/lucide/ellipsis";

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		/** The trigger's accessible name and tooltip. */
		label: string;
		children: Snippet;
	}
	let { open, onOpenChange, label, children }: Props = $props();
</script>

<DropdownMenu.Root {open} {onOpenChange}>
	<DropdownMenu.Trigger
		class="nav-kebab nav-reveal ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 data-[state=open]:bg-gray-100 dark:hover:bg-gray-700 dark:data-[state=open]:bg-gray-700"
		title={label}
		aria-label={label}
	>
		<IconKebab class="size-3.5" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 max-w-72 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
			side="bottom"
			align="end"
			sideOffset={6}
			trapFocus={false}
			onCloseAutoFocus={(e) => e.preventDefault()}
			interactOutsideBehavior="defer-otherwise-close"
		>
			{@render children()}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
