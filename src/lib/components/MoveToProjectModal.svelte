<!--
	"Move to project…": a small picker for one conversation.

	Lists the projects the person can open (their own and those shared with
	them), marks the one the chat is in, and offers "None" to take it out when
	it is in one. A search box appears once the list is long enough to need it.
	Picking a row moves the chat at once (the server enforces who may) and
	closes; the toast and the sidebar update come from `useMoveConversation`.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import Modal from "$lib/components/Modal.svelte";
	import { useMoveConversation, type MovableChat } from "$lib/utils/useMoveConversation";
	import type { ProjectView } from "$lib/types/Project";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonClose from "~icons/carbon/close";
	import CarbonSearch from "~icons/carbon/search";
	import LucideFolder from "~icons/lucide/folder";
	import LucideFolderMinus from "~icons/lucide/folder-minus";

	interface Props {
		chat: MovableChat & { projectId?: string };
		onclose?: () => void;
		/** Called after a successful move, with the project it is in now (or null). */
		onmoved?: (to: { id: string; name: string } | null) => void;
	}

	let { chat, onclose, onmoved }: Props = $props();

	const move = useMoveConversation();

	/** A list this short needs no search. */
	const SEARCH_FROM = 7;

	let projects = $state<ProjectView[] | null>(null);
	let failed = $state(false);
	let query = $state("");
	let busy = $state(false);

	const shown = $derived(
		(projects ?? []).filter((project) =>
			project.name.toLowerCase().includes(query.trim().toLowerCase())
		)
	);
	const current = $derived(projects?.find((project) => project.id === chat.projectId));

	onMount(async () => {
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) throw new Error(String(response.status));
			projects = ((await response.json()) as { data: ProjectView[] }).data;
		} catch {
			failed = true;
		}
	});

	async function choose(target: { id: string; name: string } | null) {
		if (busy) return;
		busy = true;
		const ok = await move(chat, target, current?.name);
		busy = false;
		if (ok) {
			onmoved?.(target);
			onclose?.();
		}
	}

	const ROW =
		"flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-gray-700 select-none hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:outline-hidden disabled:opacity-60 dark:text-gray-200 dark:hover:bg-white/10 dark:focus-visible:bg-white/10";
</script>

<Modal {onclose} sheet labelledBy="move-to-project-title" width="w-[90dvw] md:w-[420px]">
	<div class="flex w-full flex-col gap-4 p-5">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h2
					id="move-to-project-title"
					class="text-lg font-semibold text-gray-800 dark:text-gray-200"
				>
					Move to project
				</h2>
				<p class="truncate text-sm text-gray-500 dark:text-gray-400">{chat.title}</p>
			</div>
			<button
				type="button"
				class="flex size-6 shrink-0 items-center justify-center text-gray-700 hover:text-gray-500 dark:text-gray-300 dark:hover:text-gray-400"
				onclick={onclose}
				aria-label="Close"
			>
				<CarbonClose class="size-5" />
			</button>
		</div>

		{#if projects && projects.length >= SEARCH_FROM}
			<div class="relative">
				<CarbonSearch
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
				/>
				<input
					type="search"
					bind:value={query}
					placeholder="Search projects"
					aria-label="Search projects"
					autocomplete="off"
					class="h-10 w-full rounded-lg border border-gray-200 bg-white pr-3 pl-9 text-sm text-gray-800 focus:border-gray-400 focus:outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
				/>
			</div>
		{/if}

		<div
			class="scrollbar-custom flex max-h-72 flex-col gap-0.5 overflow-y-auto"
			role="group"
			aria-label="Projects"
		>
			{#if failed}
				<p class="px-2 py-3 text-sm text-red-600 dark:text-red-400">
					Could not load your projects.
				</p>
			{:else if projects === null}
				<p class="px-2 py-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
			{:else}
				{#if chat.projectId}
					<button type="button" class={ROW} disabled={busy} onclick={() => choose(null)}>
						<LucideFolderMinus class="size-4 shrink-0 opacity-80" />
						<span class="min-w-0 flex-1 truncate">None (remove from project)</span>
					</button>
				{/if}
				{#each shown as project (project.id)}
					{@const here = project.id === chat.projectId}
					<button
						type="button"
						class="{ROW} {here ? 'font-medium' : ''}"
						disabled={busy || here}
						aria-current={here ? "true" : undefined}
						onclick={() => choose({ id: project.id, name: project.name })}
					>
						<LucideFolder class="size-4 shrink-0 opacity-80" />
						<span class="min-w-0 flex-1 truncate">{project.name}</span>
						{#if here}
							<span class="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
								<CarbonCheckmark class="size-3.5" />
								Current
							</span>
						{/if}
					</button>
				{:else}
					<p class="px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
						{projects.length === 0 ? "You have no projects yet." : "No project matches."}
					</p>
				{/each}
			{/if}
		</div>
	</div>
</Modal>
