<!--
	The `⋯` on a chat row outside the sidebar (the Chats list, a project's
	chats): "Move to project…", "Remove from project" where the chat is in one
	and the caller may take it out, and "Delete" where the caller may delete
	the chat. Always drawn, for the same reason the sidebar's own `⋯` is on
	touch screens: there is no hover there.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { DropdownMenu } from "bits-ui";
	import LucideEllipsis from "~icons/lucide/ellipsis";
	import LucideFolderInput from "~icons/lucide/folder-input";
	import LucideFolderMinus from "~icons/lucide/folder-minus";
	import CarbonTrashCan from "~icons/carbon/trash-can";

	interface Props {
		/** The chat's title, for screen readers. */
		label: string;
		/** Given, "Move to project…" is offered and calls this. */
		onmove?: () => void;
		/** Given, "Remove from project" is offered and calls this. */
		onremove?: () => void;
		/** Given, "Delete" is offered and calls this. The caller confirms. */
		ondelete?: () => void;
	}

	let { label, onmove, onremove, ondelete }: Props = $props();

	const ITEM =
		"flex h-9 items-center gap-2 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10";
	// The tint is the sidebar row menu's delete item's (NavConversationItem).
	const DELETE_ITEM =
		"flex h-9 items-center gap-2 rounded-md px-2 text-sm text-red-500 select-none focus-visible:outline-hidden data-highlighted:bg-red-50 data-highlighted:text-red-600 sm:h-8 dark:text-red-400 dark:data-highlighted:bg-red-500/10 dark:data-highlighted:text-red-400";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-200 hover:text-gray-600 data-[state=open]:bg-gray-200 data-[state=open]:text-gray-600 dark:hover:bg-gray-600 dark:hover:text-gray-200 dark:data-[state=open]:bg-gray-600 dark:data-[state=open]:text-gray-200"
		aria-label={m["app.move_menu.actions_for"]({ label })}
		title={m["app.move_menu.more_options"]()}
	>
		<LucideEllipsis class="size-4" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 min-w-44 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
			side="bottom"
			align="end"
			sideOffset={4}
			trapFocus={false}
			onCloseAutoFocus={(e) => e.preventDefault()}
		>
			{#if onmove}
				<DropdownMenu.Item class={ITEM} onSelect={onmove}>
					<LucideFolderInput class="size-4 opacity-90 dark:opacity-80" />
					{m["app.move_menu.move"]()}
				</DropdownMenu.Item>
			{/if}
			{#if onremove}
				<DropdownMenu.Item class={ITEM} onSelect={onremove}>
					<LucideFolderMinus class="size-4 opacity-90 dark:opacity-80" />
					{m["app.move_menu.remove"]()}
				</DropdownMenu.Item>
			{/if}
			{#if ondelete}
				<DropdownMenu.Item class={DELETE_ITEM} onSelect={ondelete}>
					<CarbonTrashCan class="size-4 opacity-90 dark:opacity-80" />
					{m["app.nav_item.delete"]()}
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
