<!--
	Projects in the tree: a branch of folders, each holding its own chats.

	**Managing one happens on its own row**, through the `⋯` beside it — Edit
	opens that project, Delete removes it after a confirmation. There is no
	route from here to a list of every project, deliberately: reaching a
	project's settings by opening an overlay, finding it in a list and clicking
	it is three steps to do something the row was already pointing at.

	The `+` on the header line is the one thing that is not about an existing
	project, so it is the one thing on the header line.

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
	import RowMenu from "./RowMenu.svelte";
	import type { ProjectView } from "$lib/types/Project";
	import CarbonFolder from "~icons/carbon/folder";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrash from "~icons/carbon/trash-can";

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
		mine: boolean;
	}

	interface Props {
		/** Opens one project's overlay: an id to edit, nothing to create. */
		onopen: (id?: string) => void;
		onnavigate?: () => void;
	}

	let { onopen, onnavigate }: Props = $props();

	let open = $state(false);
	let projects = $state<ProjectView[]>([]);
	let loaded = $state(false);
	let failed = $state(false);
	let busy = $state(false);

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

	/**
	 * Delete one project from its own row.
	 *
	 * The confirmation says what is *kept*, because the surprising part is that
	 * nothing else goes: the conversations return to the ordinary Chats list and
	 * the knowledge bases are gateway resources with their own owner. Somebody
	 * tidying a sidebar should not have to guess whether they are about to lose
	 * a month of chats.
	 */
	async function destroy(project: ProjectView) {
		if (
			!confirm(
				`Delete the project “${project.name}”?\n\nIts conversations and knowledge bases are ` +
					"kept — the chats go back to your ordinary list."
			)
		)
			return;
		busy = true;
		try {
			const response = await fetch(`${base}/api/v2/projects/${project.id}`, {
				method: "DELETE",
			});
			if (!response.ok) throw new Error(String(response.status));
			delete chats[project.id];
			delete expanded[project.id];
			await loadProjects();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	/** Called by the parent after a project's overlay closes. */
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
	{#snippet icon()}
		<CarbonFolder class="size-3.5 shrink-0" />
	{/snippet}

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
			>
				{#snippet icon()}
					<CarbonFolder class="size-3.5 shrink-0" />
				{/snippet}

				{#snippet actions()}
					<RowMenu label={project.name}>
						{#snippet children(close)}
							<button
								type="button"
								role="menuitem"
								onclick={() => {
									close();
									onopen(project.id);
								}}
								class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
							>
								<CarbonEdit class="size-3.5" />
								Edit
							</button>
							{#if project.owned}
								<button
									type="button"
									role="menuitem"
									disabled={busy}
									onclick={() => {
										close();
										void destroy(project);
									}}
									class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
								>
									<CarbonTrash class="size-3.5" />
									Delete
								</button>
							{/if}
						{/snippet}
					</RowMenu>
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
