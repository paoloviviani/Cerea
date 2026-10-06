<!--
	The list of projects, as the `/projects` page.

	It used to be an overlay with three views (list, form, detail) and was the
	only way to edit a project. A project is a page now (`ProjectPage`), so this
	is only the list: each card is a link to that page, and "New project" is a
	link to `/projects/new`. The sidebar tree is still where people mostly get
	to a project; this is for whoever arrives from a link, or wants all of them
	with their counts.

	Loads in `onMount`: this renders as a page, and a page body runs on the
	server, where a relative fetch has no origin.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import type { ProjectView } from "$lib/types/Project";
	import * as s from "$lib/components/overlay/styles";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconChat from "~icons/carbon/chat";
	import LucideFolderOpen from "~icons/lucide/folder-open";

	const knowledgeOn = $derived(
		(page.data as { knowledgeEnabled?: boolean }).knowledgeEnabled !== false
	);

	let projects = $state<ProjectView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	const conversationTotal = $derived(
		projects.reduce((total, project) => total + project.conversationCount, 0)
	);

	onMount(async () => {
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) throw new Error(`The request failed (${response.status}).`);
			projects = ((await response.json()) as { data: ProjectView[] }).data;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load projects.";
		} finally {
			loading = false;
		}
	});
</script>

<div class="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
	<header>
		<h1 class="text-xl font-semibold text-ink">Projects</h1>
		<p class={s.SUBTITLE}>
			Conversations that share standing instructions, documents and knowledge.
		</p>
	</header>

	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
		{#if failure}
			<p class="{s.ERROR} mb-4">{failure}</p>
		{/if}

		<div class="{s.STRIP} {projects.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
			<div class="flex items-center gap-3">
				<div class={s.STRIP_TILE} class:grayscale={projects.length === 0}>
					<LucideFolderOpen class="size-5 text-accent" />
				</div>
				<div>
					<p class={s.STRIP_HEADLINE}>
						{projects.length}
						{projects.length === 1 ? "project" : "projects"}
					</p>
					<p class={s.STRIP_DETAIL}>
						{conversationTotal} conversation{conversationTotal === 1 ? "" : "s"} in them
					</p>
				</div>
			</div>
			<a href="{base}/projects/new" class={s.PRIMARY}>
				<IconAddLarge class="size-4" />
				New project
			</a>
		</div>

		<div class={s.STACK}>
			{#if loading}
				<p class={s.SUBTITLE}>Loading…</p>
			{:else if projects.length === 0}
				<div class={s.EMPTY}>
					<LucideFolderOpen class={s.EMPTY_ICON} />
					<p class={s.EMPTY_TITLE}>No projects yet</p>
					<p class={s.EMPTY_DETAIL}>
						Give a group of chats the same instructions and the same documents
					</p>
					<a href="{base}/projects/new" class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						Create Your First Project
					</a>
				</div>
			{:else}
				<div>
					<h2 class={s.SECTION_TITLE}>Yours and shared with you ({projects.length})</h2>
					<div class={s.GRID}>
						{#each projects as project (project.id)}
							<a
								href="{base}/projects/{project.id}"
								class="{s.card(project.conversationCount > 0)} text-left no-underline"
							>
								<div class={s.CARD_BODY}>
									<div class="mb-3 min-w-0">
										<div class="mb-0.5 flex items-center gap-2">
											<LucideFolderOpen class="size-4 flex-shrink-0 text-ink-faint" />
											<h3 class={s.CARD_TITLE}>{project.name}</h3>
										</div>
										<p class={s.CARD_SUBTITLE}>{project.description || "No description"}</p>
									</div>
									<div class="flex flex-wrap items-center gap-2">
										<span class="{s.PILL} {s.PILL_TONES.busy}">
											<IconChat class="size-3" />
											{project.conversationCount}
										</span>
										{#if knowledgeOn && project.knowledgeBaseIds.length > 0}
											<span class="text-xs text-ink-muted">
												{project.knowledgeBaseIds.length} base{project.knowledgeBaseIds.length === 1
													? ""
													: "s"}
											</span>
										{/if}
										{#if knowledgeOn && project.indexPastChats}
											<span class="{s.PILL} {s.PILL_TONES.good}">past chats</span>
										{/if}
										{#if !project.owned}
											<span class="{s.PILL} {s.PILL_TONES.neutral}">shared with you</span>
										{/if}
									</div>
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			<div class={s.TIPS}>
				<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
				<ul class={s.TIPS_LIST}>
					<li>• Every chat started in a project carries its instructions, documents and memory.</li>
					<li>• A shared project is a shared workspace — everyone sees every conversation.</li>
					<li>• Sharing a project does <strong>not</strong> share its knowledge bases.</li>
					<li>• Deleting a project keeps its chats; they return to your ordinary list.</li>
				</ul>
			</div>
		</div>
	</div>
</div>
