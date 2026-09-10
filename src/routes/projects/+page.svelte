<!--
	Projects: conversations grouped around standing context (ADR 0062).

	A project is this application's, not the gateway's, because it groups
	*conversations* — but the knowledge bases it attaches are the gateway's, so
	they are offered here by name and never copied.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import CarbonAdd from "~icons/carbon/add";
	import ProjectModal from "$lib/components/ProjectModal.svelte";
	import { GatewayError, gwGet, type VectorStore } from "$lib/gateway";
	import type { ProjectView } from "$lib/types/Project";

	let projects = $state<ProjectView[]>([]);
	let stores = $state<VectorStore[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let showCreate = $state(false);

	async function load() {
		failure = null;
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) throw new Error(`Could not load projects (${response.status}).`);
			projects = ((await response.json()) as { data: ProjectView[] }).data;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load projects.";
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await load();
		try {
			// The bases *this* person can reach, for the dialog's checklist.
			// A failure here is not fatal: a project without knowledge bases is
			// still a project.
			stores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
		}
	});

	function saved(project: ProjectView) {
		projects = [project, ...projects.filter((entry) => entry.id !== project.id)];
	}
</script>

<svelte:head><title>Projects</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h1 class="text-xl font-semibold">Projects</h1>
			<p class="text-sm text-gray-500 dark:text-gray-400">
				Conversations that share standing instructions and knowledge. Every chat you start in a
				project gets both.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (showCreate = true)}
			class="flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
		>
			<CarbonAdd /> New
		</button>
	</header>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if projects.length === 0}
		<p class="text-sm text-gray-500">
			No projects yet. <button type="button" onclick={() => (showCreate = true)} class="underline"
				>Create one</button
			> to give a group of chats the same instructions and documents.
		</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each projects as project (project.id)}
				<li>
					<a
						href="{base}/projects/{project.id}"
						class="flex flex-col gap-1 rounded-lg border border-gray-200 p-4 no-underline hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{project.name}</span>
							{#if !project.owned}
								<span
									class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
									>shared with you</span
								>
							{/if}
						</div>
						{#if project.description}
							<div class="text-sm text-gray-500 dark:text-gray-400">{project.description}</div>
						{/if}
						<div class="text-xs text-gray-500 dark:text-gray-400">
							{project.conversationCount} conversation{project.conversationCount === 1 ? "" : "s"}
							{#if project.knowledgeBaseIds.length > 0}
								· {project.knowledgeBaseIds.length} knowledge base{project.knowledgeBaseIds
									.length === 1
									? ""
									: "s"}
							{/if}
							{#if project.indexPastChats}
								· past chats searchable
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if showCreate}
	<ProjectModal {stores} onsaved={saved} onclose={() => (showCreate = false)} />
{/if}
