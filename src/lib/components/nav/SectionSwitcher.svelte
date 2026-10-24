<!--
	The section switcher: what a page's tab row becomes on a phone.

	Workspace, Settings and Administration each have a row of tabs that wraps
	onto three lines below `md`. On a phone the row is replaced by one button
	under the page title that names the current section (icon, label, chevron);
	it opens a bottom sheet listing every section, the current one marked.
	From `md` up this renders nothing, so the caller keeps its tab row there
	(and hides the row below `md`).

	Each section is a plain link to its own address, so deep links, the back
	button and a long-press all behave as they do on the tabs. Selecting one
	closes the sheet. The sheet is the app's `Modal` (`sheet`): Escape closes it,
	focus starts on the current section and goes back to the button afterwards.
-->
<script lang="ts" module>
	import type { Component, ComponentType, SvelteComponent } from "svelte";

	export interface Section {
		/** The address the section lives at. */
		href: string;
		label: string;
		/** An icon component taking `class`: the unplugin icons are class components, ours are runes. */
		icon: Component<{ class?: string }> | ComponentType<SvelteComponent<{ class?: string }>>;
	}
</script>

<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import LucideChevronDown from "~icons/lucide/chevron-down";
	import LucideCheck from "~icons/lucide/check";

	interface Props {
		/** Names the sheet, e.g. "Workspace sections". */
		label: string;
		sections: Section[];
		/** The `href` of the current section. */
		current: string;
	}

	let { label, sections, current }: Props = $props();

	let open = $state(false);
	let listEl = $state<HTMLElement>();
	const active = $derived(sections.find((section) => section.href === current) ?? sections[0]);
	const titleId = `section-switcher-${Math.random().toString(36).slice(2, 8)}`;

	// After the Modal's own mount has focused the dialog.
	$effect(() => {
		if (open) listEl?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
	});
</script>

{#if active}
	<button
		type="button"
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-label="{label}: {active.label}"
		onclick={() => (open = true)}
		data-testid="section-switcher"
		class="flex w-fit max-w-full items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 md:hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
	>
		<active.icon class="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
		<span class="truncate">{active.label}</span>
		<LucideChevronDown class="size-4 shrink-0 text-gray-500" />
	</button>
{/if}

{#if open}
	<Modal sheet width="sm:w-96" labelledBy={titleId} onclose={() => (open = false)}>
		<div class="p-4 pb-6 sm:p-5">
			<h2 id={titleId} class="mb-2 px-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
				{label}
			</h2>
			<ul bind:this={listEl} class="flex flex-col gap-0.5">
				{#each sections as section (section.href)}
					{@const isCurrent = section.href === active?.href}
					<li>
						<a
							href={section.href}
							aria-current={isCurrent ? "page" : undefined}
							onclick={() => (open = false)}
							class="flex items-center gap-3 rounded-lg px-3 py-3 text-base {isCurrent
								? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/20 dark:text-blue-300'
								: 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'}"
						>
							<section.icon class="size-5 shrink-0" />
							<span class="min-w-0 flex-1">{section.label}</span>
							{#if isCurrent}<LucideCheck class="size-4 shrink-0" />{/if}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	</Modal>
{/if}
