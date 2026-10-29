<!--
	The page shell for a settings page: one centred column, with an optional
	sticky index on its left that scrolls to each section.

	This is the intended pattern for settings pages (the project settings tab
	is the first to use it): the page is a column of `SettingsGroup`s, each a
	heading with `SettingsSection` cards under it, and `index` lists the
	groups and sections as anchor links. The index shows from `lg:` up and is
	hidden on narrow screens, where the column is short enough to scroll.

	The index sticks to the top of the scroll container the shell sits in (the
	page's own `overflow-y-auto` area), and a click scrolls that container
	with `scrollIntoView`, so it works wherever the shell is mounted. A link
	targets the `id` of a `SettingsGroup` or `SettingsSection`.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	export interface SettingsIndexItem {
		/** The `id` of the group or section this link scrolls to. */
		id: string;
		label: string;
		/** A section under a group: indented in the index. */
		nested?: boolean;
	}

	interface Props {
		/** Accessible name of the index. Required when `index` is given. */
		indexLabel?: string;
		index?: SettingsIndexItem[];
		children: Snippet;
	}

	let { indexLabel, index = [], children }: Props = $props();

	function go(event: MouseEvent, id: string) {
		const target = document.getElementById(id);
		if (!target) return;
		event.preventDefault();
		target.scrollIntoView({ behavior: "smooth", block: "start" });
	}
</script>

<div class="lg:grid lg:grid-cols-[11rem_minmax(0,48rem)] lg:gap-8">
	{#if index.length > 0}
		<nav
			aria-label={indexLabel}
			data-testid="settings-index"
			class="sticky top-0 hidden max-h-full self-start overflow-y-auto lg:block"
		>
			<ul class="space-y-0.5 text-sm">
				{#each index as item (item.id)}
					<li>
						<a
							href="#{item.id}"
							onclick={(event) => go(event, item.id)}
							class="block rounded-md px-2 py-1 no-underline hover:bg-sunken hover:text-ink {item.nested
								? 'pl-5 text-xs text-ink-muted'
								: 'font-medium text-ink-muted'}"
						>
							{item.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	{/if}
	<div class="flex min-w-0 flex-col gap-8 {index.length > 0 ? '' : 'lg:col-span-2 lg:max-w-3xl'}">
		{@render children()}
	</div>
</div>
