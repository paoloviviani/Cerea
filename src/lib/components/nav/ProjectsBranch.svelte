<!--
	Projects in the tree: a branch of folders, each holding its own chats.

	**Managing one happens on its own row**, through the `⋯` beside it — Project
	settings goes to that project's page, Delete removes it after a confirmation. **Starting a
	chat in one also happens on its own row**, through the `+` — it creates a
	conversation with the project attached and goes there, because standing
	context applies from the conversation itself and the project page would only
	be three steps to the same POST. There is no route from here to a list of
	every project, deliberately: the row already points at the project.

	The `+` on the header line is the one thing that is not about an existing
	project, so it is the one thing on the header line, and it goes to
	`/projects/new`. The page tells this tree when something changed
	(`projectsRevision`), so a rename or a removed chat shows up here without a
	reload.

	Each chat inside a project is the same row the flat Chats list uses —
	`NavConversationItem` — so it carries the same `⋯`: Rename and Delete,
	plus the double-click-to-rename inline edit. The branch just keeps its own
	list, so a rename or a delete lands where the row will show it. Its list
	is indented under a faint rail aligned with the folder's disclosure arrow:
	project chats are contents of that folder, not peers of it.

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
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import TreeBranch from "./TreeBranch.svelte";
	import TreeLeaf from "./TreeLeaf.svelte";
	import RowMenu from "./RowMenu.svelte";
	import NavConversationItem from "../NavConversationItem.svelte";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { projectsRevision } from "$lib/stores/projectsRevision";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import type { ProjectView } from "$lib/types/Project";
	import CarbonFolder from "~icons/carbon/folder";
	import CarbonSettings from "~icons/carbon/settings";
	import CarbonTrash from "~icons/carbon/trash-can";

	const settings = useSettingsStore();
	const client = useAPIClient();
	// A chat named by its first generation gets the title here too, live.
	const convsStore = useConversationsStore();

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
	}

	const openProject = (id?: string) => goto(`${base}/projects/${id ?? "new"}`);

	let open = $state(false);
	let projects = $state<ProjectView[]>([]);
	let loaded = $state(false);
	let failed = $state(false);
	let busy = $state(false);

	// Which folders are expanded, and what is in them. Kept across closes so a
	// reopened folder does not blink.
	let expanded = $state<Record<string, boolean>>({});
	let chats = $state<Record<string, ProjectConversation[]>>({});
	/** The project whose new chat is being created, for the in-flight guard. */
	let starting = $state<string | null>(null);

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
	 * Start a new chat inside the project, from the row itself.
	 *
	 * The `+` beside a project means "chat with what this project knows", not
	 * "change what this project is" — that stays with the `⋯` menu. The only
	 * thing needed is creating the conversation *with the project attached*:
	 * `/conversation` takes a projectId, and the project's instructions and
	 * knowledge bases join every turn at generation time from `conv.projectId`
	 * (ADR 0062), so there is nothing to copy in here. Which is why starting a
	 * chat never needed the overlay at all — the overlay only created the
	 * conversation with the project attached after three steps through the
	 * project's own settings.
	 *
	 * The model is the one a plain new chat would use: the person's active
	 * model, or the first in the list.
	 */
	async function startChat(project: ProjectView) {
		if (starting) return;
		const models: { id: string }[] = page.data.models ?? [];
		if (models.length === 0) return;
		const model = models.some((entry) => entry.id === $settings.activeModel)
			? $settings.activeModel
			: models[0].id;
		starting = project.id;
		try {
			const response = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, projectId: project.id }),
			});
			if (!response.ok) {
				let message = "Could not start the chat.";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// An HTML error page says the same thing less usefully.
				}
				throw new Error(message);
			}
			const { conversationId } = (await response.json()) as { conversationId: string };
			// The branch keeps its own lists, so put the new chat where the row
			// will show it when this comes back: opened, counted, first in the
			// folder. No refetch — the title arrives when the generation names it.
			projects = projects.map((entry) =>
				entry.id === project.id
					? { ...entry, conversationCount: entry.conversationCount + 1 }
					: entry
			);
			expanded = { ...expanded, [project.id]: true };
			if (chats[project.id] !== undefined) {
				chats = {
					...chats,
					[project.id]: [
						{
							id: conversationId,
							// Matches the server's own default title (and the flat
							// Chats list's); the real one arrives once a turn names it.
							title: "New Chat",
							model,
							updatedAt: new Date().toISOString(),
						},
						...chats[project.id],
					],
				};
			}
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : "Could not start the chat.");
		} finally {
			starting = null;
		}
	}

	/**
	 * Rename one of the project's chats, from its row's `⋯` menu.
	 *
	 * The same endpoint and optimistic write the flat Chats list uses; the
	 * branch just keeps its own list, so the new title lands where the row
	 * will show it.
	 */
	async function renameChat(projectId: string, conversationId: string, title: string) {
		const before = chats[projectId] ?? [];
		chats = {
			...chats,
			[projectId]: before.map((entry) =>
				entry.id === conversationId ? { ...entry, title } : entry
			),
		};
		try {
			await client.conversations({ id: conversationId }).patch({ title }).then(handleResponse);
		} catch (err) {
			console.error(err);
			alert("Could not rename the chat.");
		}
	}

	/**
	 * Delete one of the project's chats, from its row's `⋯` menu.
	 *
	 * Only the conversation goes — deleting a chat is not a step towards
	 * anything else. It is removed from the folder at once, and if it was the
	 * one on screen the app returns to the ordinary list, mirroring what
	 * deleting from the flat Chats list does.
	 */
	async function destroyChat(projectId: string, conversationId: string) {
		chats = {
			...chats,
			[projectId]: (chats[projectId] ?? []).filter((entry) => entry.id !== conversationId),
		};
		projects = projects.map((entry) =>
			entry.id === projectId
				? { ...entry, conversationCount: Math.max(0, entry.conversationCount - 1) }
				: entry
		);
		if (page.params.id === conversationId) {
			await goto(base);
		}
		try {
			await client.conversations({ id: conversationId }).delete().then(handleResponse);
		} catch (err) {
			console.error(err);
			alert("Could not delete the chat.");
		}
	}

	/**
	 * Delete one project from its own row.
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
		// The memory is the one thing that would otherwise stay behind holding
		// what was said: a second question, so "no" still deletes the project.
		const withMemory =
			project.owned &&
			project.hasMemory &&
			confirm(
				`Also delete “${project.name}” — past chats?\n\nThat is the searchable memory of this ` +
					"project's conversations. OK = delete the memory too. Cancel = keep the memory (the project is still deleted)."
			);
		busy = true;
		try {
			const response = await fetch(
				`${base}/api/v2/projects/${project.id}${withMemory ? "?memory=delete" : ""}`,
				{ method: "DELETE" }
			);
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

	/** The project page changed something this tree shows. */
	async function reload() {
		if (!loaded && !open) return;
		chats = {};
		await loadProjects();
	}

	let seenRevision = $projectsRevision;
	$effect(() => {
		const revision = $projectsRevision;
		if (revision === seenRevision) return;
		seenRevision = revision;
		void reload();
	});
</script>

<TreeBranch
	label="Projects"
	badge={loaded && !failed ? projects.length : undefined}
	{open}
	onactivate={toggleBranch}
	onadd={() => openProject()}
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
		<TreeLeaf label="No projects yet" depth={1} onclick={() => openProject()} />
	{:else}
		{#each projects as project (project.id)}
			<TreeBranch
				label={project.name}
				depth={1}
				badge={project.conversationCount || undefined}
				open={expanded[project.id] ?? false}
				onactivate={() => toggleFolder(project)}
				onadd={() => startChat(project)}
				addTitle="New chat"
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
									void openProject(project.id);
								}}
								class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
							>
								<CarbonSettings class="size-3.5" />
								Settings
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
						onclick={() => startChat(project)}
						title="Start a chat"
					/>
				{:else}
					<!-- The guide begins at the folder's disclosure-arrow centre. Its
					     padding plus the shared row's own padding leaves chat titles
					     aligned with the other depth-two leaves. -->
					<div
						class="ml-[1.375rem] flex flex-col gap-px border-l border-gray-200 pl-2.5 dark:border-gray-700"
					>
						{#each chats[project.id] as conversation (conversation.id)}
							{@const sidebarConv = {
								id: conversation.id,
								title: convsStore?.titles[conversation.id] ?? conversation.title,
								model: conversation.model,
								updatedAt: new Date(conversation.updatedAt),
							} as ConvSidebar}
							<NavConversationItem
								conv={sidebarConv}
								oneditConversationTitle={(payload) =>
									renameChat(project.id, payload.id, payload.title)}
								ondeleteConversation={(id) => destroyChat(project.id, id)}
							/>
						{/each}
					</div>
				{/if}
			</TreeBranch>
		{/each}
	{/if}
</TreeBranch>
