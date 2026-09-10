<!--
	Projects in the tree: a branch of folders, each holding its own chats.

	The chats inside a project are fetched **when the folder is opened**, not
	with the list. A deployment with a dozen projects would otherwise make a
	dozen requests to draw a sidebar nobody has expanded, and the count on the
	closed folder already says whether there is anything in there.

	Once fetched they are kept. A folder somebody closes and reopens should not
	blink, and the list is refreshed by the branch's own reload rather than by
	every toggle.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import TreeBranch from "./TreeBranch.svelte";
	import TreeLeaf from "./TreeLeaf.svelte";
	import type { ProjectView } from "$lib/types/Project";
	import CarbonFolder from "~icons/carbon/folder";

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
		mine: boolean;
	}

	interface Props {
		/** Opens the projects overlay: with an id on a project, otherwise new. */
		onopen: (id?: string) => void;
		onnavigate?: () => void;
	}

	let { onopen, onnavigate }: Props = $props();

	let open = $state(false);
	let projects = $state<ProjectView[]>([]);
	let loaded = $state(false);
	let failed = $state(false);

	// Which folders are expanded, and what is in them. Kept across closes so a
	// reopened folder does not blink.
	let expanded = $state<Record<string, boolean>>({});
	let chats = $state<Record<string, ProjectConversation[]>>({});

	async function loadProjects() {
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) throw new Error(String(response.status));
			projects = ((await response.json()) as { data: ProjectView[] }).data;
			failed = false;
		} catch {
			// A sidebar branch is not the place to report a failure loudly: the
			// label says "unavailable" and the rest of the panel still works.
			failed = true;
		} finally {
			loaded = true;
		}
	}

	async function toggleBranch() {
		open = !open;
		if (open && !loaded) await loadProjects();
	}

	async function toggleFolder(project: ProjectView) {
		const next = !expanded[project.id];
		expanded = { ...expanded, [project.id]: next };
		if (next && chats[project.id] === undefined) {
			try {
				const response = await fetch(`${base}/api/v2/projects/${project.id}/conversations`);
				if (!response.ok) throw new Error(String(response.status));
				const listed = (await response.json()) as { data: ProjectConversation[] };
				chats = { ...chats, [project.id]: listed.data };
			} catch {
				chats = { ...chats, [project.id]: [] };
			}
		}
	}

	/** Called by the parent after a project is created or deleted. */
	export async function reload() {
		if (!loaded && !open) return;
		chats = {};
		await loadProjects();
	}

	const currentConversation = $derived(page.params.id);
</script>

<TreeBranch
	label="Projects"
	badge={loaded && !failed ? projects.length : undefined}
	{open}
	onactivate={toggleBranch}
	onadd={() => onopen()}
	addTitle="New project"
>
	{#if !loaded}
		<TreeLeaf label="Loading…" depth={1} />
	{:else if failed}
		<TreeLeaf label="Unavailable" depth={1} title="Could not load projects" />
	{:else if projects.length === 0}
		<TreeLeaf label="No projects yet" depth={1} onclick={() => onopen()} />
	{:else}
		{#each projects as project (project.id)}
			<TreeBranch
				label={project.name}
				depth={1}
				badge={project.conversationCount || undefined}
				open={expanded[project.id] ?? false}
				onactivate={() => toggleFolder(project)}
				onadd={() => onopen(project.id)}
				addTitle="Open {project.name}"
			>
				{#snippet icon()}
					<CarbonFolder class="size-3.5 shrink-0" />
				{/snippet}
				{#if chats[project.id] === undefined}
					<TreeLeaf label="Loading…" depth={2} />
				{:else if chats[project.id].length === 0}
					<TreeLeaf
						label="No chats yet"
						depth={2}
						onclick={() => onopen(project.id)}
						title="Open the project to start one"
					/>
				{:else}
					{#each chats[project.id] as conversation (conversation.id)}
						<TreeLeaf
							label={conversation.title}
							href="{base}/conversation/{conversation.id}"
							depth={2}
							active={conversation.id === currentConversation}
							title={conversation.mine
								? conversation.title
								: `${conversation.title} — somebody else's`}
							onclick={onnavigate}
						/>
					{/each}
				{/if}
			</TreeBranch>
		{/each}
	{/if}
</TreeBranch>
