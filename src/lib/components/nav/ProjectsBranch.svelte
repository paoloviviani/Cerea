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
	import { m } from "$lib/paraglide/messages";
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
	import {
		areChatsFresh,
		bindProjectsCacheOwner,
		isProjectsFresh,
		projectsTreeCache,
		type ProjectConversation,
	} from "$lib/stores/projectsTreeCache.svelte";
	import { reconcileById } from "$lib/utils/reconcileById";
	import { chatDrag } from "$lib/stores/chatDrag.svelte";
	import { useMoveConversation } from "$lib/utils/useMoveConversation";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import type { ProjectView } from "$lib/types/Project";
	import DeleteProjectModal from "../projects/DeleteProjectModal.svelte";
	import CarbonFolder from "~icons/carbon/folder";
	import CarbonSettings from "~icons/carbon/settings";
	import CarbonTrash from "~icons/carbon/trash-can";
	import { onMount } from "svelte";
	import { readProjectsTreeOpen, writeProjectsTreeOpen } from "$lib/utils/projectsTreeOpen";

	const settings = useSettingsStore();
	const client = useAPIClient();
	// A chat named by its first generation gets the title here too, live.
	const convsStore = useConversationsStore();
	const moveConversation = useMoveConversation();

	const openProject = (id?: string) => goto(`${base}/projects/${id ?? "new"}`);

	// The lists live in a module cache, not here: this branch unmounts whenever
	// the Agents view is shown, and rows held in component state began on a
	// loading row at every return to Chats.
	bindProjectsCacheOwner(page.data.user?.id);
	$effect(() => bindProjectsCacheOwner(page.data.user?.id));
	const cache = projectsTreeCache;
	let busy = $state(false);
	/** Folders whose read failed with nothing cached, so they offer a retry. */
	let chatsFailed = $state<Record<string, boolean>>({});

	/** The project whose new chat is being created, for the in-flight guard. */
	let starting = $state<string | null>(null);

	/**
	 * Which read of each list is the latest. A response that arrives after a
	 * newer read began (a folder opened, then a move bumps the revision and the
	 * tree reloads) describes the list as it was before that change, and must
	 * not overwrite what the newer read shows.
	 */
	let projectsRead = 0;
	const chatsRead: Record<string, number> = {};

	async function loadProjects() {
		const read = ++projectsRead;
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) throw new Error(String(response.status));
			const listed = ((await response.json()) as { data: ProjectView[] }).data;
			if (read !== projectsRead) return;
			// Folded in place: unchanged rows keep their objects, so nothing redraws.
			const merged = reconcileById(cache.projects, listed);
			if (merged !== cache.projects) cache.projects = merged;
			cache.fetchedAt = Date.now();
			cache.failed = false;
		} catch {
			if (read !== projectsRead) return;
			// A sidebar branch is not the place to report a failure loudly: the
			// label says "unavailable" and the rest of the panel still works.
			// Rows already known stay rather than being blanked.
			if (cache.projects.length === 0 || !cache.loaded) cache.failed = true;
		} finally {
			if (read === projectsRead) cache.loaded = true;
		}
	}

	/** Remember what is open, so a reload keeps it (a remount keeps the cache). */
	function rememberOpen() {
		writeProjectsTreeOpen(globalThis.localStorage, {
			branch: cache.open,
			projects: Object.entries(cache.expanded)
				.filter(([, isOpen]) => isOpen)
				.map(([id]) => id),
		});
	}

	/** Re-read what is on screen when it is older than the freshness window. */
	async function refreshVisible() {
		if (!cache.open && !cache.loaded) return;
		if (!isProjectsFresh()) await loadProjects();
		await Promise.all(
			Object.entries(cache.expanded)
				.filter(
					([id, isOpen]) => isOpen && cache.projects.some((p) => p.id === id) && !areChatsFresh(id)
				)
				.map(([id]) => loadChats(id))
		);
	}

	// Restore what was open once per page load: the branch, then its open
	// folders and their chats (a folder whose project is gone is dropped). Later
	// mounts draw the cache's own state in the first frame and only refresh.
	onMount(() => {
		if (cache.restored) {
			void refreshVisible();
			return;
		}
		cache.restored = true;
		const stored = readProjectsTreeOpen(globalThis.localStorage);
		if (!stored.branch && stored.projects.length === 0) return;
		cache.open = stored.branch;
		void (async () => {
			if (!cache.loaded) await loadProjects();
			const known = stored.projects.filter((id) => cache.projects.some((p) => p.id === id));
			cache.expanded = Object.fromEntries(known.map((id) => [id, true]));
			if (known.length !== stored.projects.length) rememberOpen();
			await Promise.all(
				known.filter((id) => cache.chats[id] === undefined).map((id) => loadChats(id))
			);
		})();
	});

	async function toggleBranch() {
		cache.open = !cache.open;
		rememberOpen();
		if (cache.open && !cache.loaded) await loadProjects();
		else if (cache.open) void refreshVisible();
	}

	async function toggleFolder(project: ProjectView) {
		const next = !cache.expanded[project.id];
		cache.expanded = { ...cache.expanded, [project.id]: next };
		rememberOpen();
		if (next && (cache.chats[project.id] === undefined || chatsFailed[project.id]))
			await loadChats(project.id);
		else if (next && !areChatsFresh(project.id)) void loadChats(project.id);
	}

	async function loadChats(projectId: string) {
		const read = (chatsRead[projectId] = (chatsRead[projectId] ?? 0) + 1);
		try {
			const response = await fetch(`${base}/api/v2/projects/${projectId}/conversations`);
			if (!response.ok) throw new Error(String(response.status));
			const listed = (await response.json()) as {
				data: ProjectConversation[];
				othersCount?: number;
			};
			if (read !== chatsRead[projectId]) return;
			const prev = cache.chats[projectId];
			const merged = prev ? reconcileById(prev, listed.data) : listed.data;
			if (merged !== prev) cache.chats[projectId] = merged;
			const othersCount = listed.othersCount ?? 0;
			if (cache.others[projectId] !== othersCount) cache.others[projectId] = othersCount;
			cache.chatsFetchedAt[projectId] = Date.now();
			if (chatsFailed[projectId]) chatsFailed = { ...chatsFailed, [projectId]: false };
		} catch {
			if (read !== chatsRead[projectId]) return;
			// Not an empty folder: saying "No chats yet" about a folder that
			// could not be read would be wrong, and kept, would never be retried.
			// Rows already known stay.
			if (cache.chats[projectId] === undefined) chatsFailed = { ...chatsFailed, [projectId]: true };
		}
	}

	/** A sidebar chat was dropped on a project's row: move it in. */
	async function dropOn(project: ProjectView) {
		const dragged = chatDrag.current;
		chatDrag.current = null;
		if (!dragged || dragged.projectId === project.id) return;
		const from = dragged.projectId
			? cache.projects.find((entry) => entry.id === dragged.projectId)
			: undefined;
		const ok = await moveConversation(
			{ id: dragged.id, title: dragged.title, model: dragged.model },
			{ id: project.id, name: project.name },
			from?.name
		);
		if (ok) {
			cache.expanded = { ...cache.expanded, [project.id]: true };
			rememberOpen();
			rememberOpen();
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
				let message: string = m["nav.projects.start_failed"]();
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
			cache.projects = cache.projects.map((entry) =>
				entry.id === project.id
					? { ...entry, conversationCount: entry.conversationCount + 1 }
					: entry
			);
			cache.expanded = { ...cache.expanded, [project.id]: true };
			if (cache.chats[project.id] !== undefined) {
				cache.chats = {
					...cache.chats,
					[project.id]: [
						{
							id: conversationId,
							// Matches the server's own default title (and the flat
							// Chats list's); the real one arrives once a turn names it.
							title: m["app.default_chat_title"](),
							model,
							updatedAt: new Date().toISOString(),
						},
						...cache.chats[project.id],
					],
				};
			}
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : m["nav.projects.start_failed"]());
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
		const before = cache.chats[projectId] ?? [];
		cache.chats = {
			...cache.chats,
			[projectId]: before.map((entry) =>
				entry.id === conversationId ? { ...entry, title } : entry
			),
		};
		try {
			await client.conversations({ id: conversationId }).patch({ title }).then(handleResponse);
		} catch (err) {
			console.error(err);
			alert(m["nav.projects.rename_failed"]());
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
		cache.chats = {
			...cache.chats,
			[projectId]: (cache.chats[projectId] ?? []).filter((entry) => entry.id !== conversationId),
		};
		cache.projects = cache.projects.map((entry) =>
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
			alert(m["nav.projects.delete_chat_failed"]());
		}
	}

	/**
	 * Delete one project from its own row, through the shared modal, which says
	 * what goes (its chats unless kept, notes, files, past-chats base) and what
	 * is kept (attached knowledge bases, other members' chats).
	 */
	let deleting = $state<ProjectView | null>(null);

	async function destroy(project: ProjectView, keepChats: boolean) {
		busy = true;
		try {
			const response = await fetch(
				`${base}/api/v2/projects/${project.id}${keepChats ? "?keepChats=1" : ""}`,
				{ method: "DELETE" }
			);
			if (!response.ok) throw new Error(String(response.status));
			delete cache.chats[project.id];
			delete cache.expanded[project.id];
			rememberOpen();
			await loadProjects();
		} catch {
			throw new Error(m["projects.page.delete.failed"]());
		} finally {
			busy = false;
		}
	}

	/** The project page changed something this tree shows. */
	async function reload() {
		if (!cache.loaded && !cache.open) return;
		// A folder read already in flight began before whatever changed.
		for (const id of Object.keys(chatsRead)) chatsRead[id] += 1;
		await loadProjects();
		// A folder that is open must show its chats again, not wait for a toggle;
		// they fold in place, so the rows on screen do not blink meanwhile.
		await Promise.all(
			Object.entries(cache.expanded)
				.filter(([id, isOpen]) => isOpen && cache.projects.some((project) => project.id === id))
				.map(([id]) => loadChats(id))
		);
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
	label={m["nav.projects.title"]()}
	href="{base}/projects"
	badge={cache.loaded && !cache.failed ? cache.projects.length : undefined}
	open={cache.open}
	onactivate={toggleBranch}
	onadd={() => openProject()}
	addTitle={m["nav.projects.new_project"]()}
>
	{#snippet icon()}
		<CarbonFolder class="size-3.5 shrink-0" />
	{/snippet}

	{#if !cache.loaded}
		<TreeLeaf label={m["nav.projects.loading"]()} depth={1} />
	{:else if cache.failed}
		<TreeLeaf
			label={m["nav.projects.unavailable"]()}
			depth={1}
			title={m["nav.projects.load_failed"]()}
		/>
	{:else if cache.projects.length === 0}
		<TreeLeaf label={m["nav.projects.none"]()} depth={1} onclick={() => openProject()} />
	{:else}
		{#each cache.projects as project (project.id)}
			<TreeBranch
				label={project.name}
				href="{base}/projects/{project.id}"
				depth={1}
				badge={project.conversationCount || undefined}
				open={cache.expanded[project.id] ?? false}
				onactivate={() => toggleFolder(project)}
				onadd={() => startChat(project)}
				addTitle={m["nav.projects.new_chat"]()}
				acceptsChat={() => chatDrag.current !== null && chatDrag.current.projectId !== project.id}
				ondropchat={() => dropOn(project)}
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
								{m["nav.projects.settings"]()}
							</button>
							{#if project.owned}
								<button
									type="button"
									role="menuitem"
									disabled={busy}
									onclick={() => {
										close();
										deleting = project;
									}}
									class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
								>
									<CarbonTrash class="size-3.5" />
									{m["nav.projects.delete"]()}
								</button>
							{/if}
						{/snippet}
					</RowMenu>
				{/snippet}

				{#if chatsFailed[project.id]}
					<TreeLeaf
						label={m["nav.projects.chats_failed"]()}
						depth={2}
						onclick={() => loadChats(project.id)}
						title={m["nav.projects.try_again"]()}
					/>
				{:else if cache.chats[project.id] === undefined}
					<TreeLeaf label={m["nav.projects.loading"]()} depth={2} />
				{:else if cache.chats[project.id].length === 0}
					<TreeLeaf
						label={m["nav.projects.no_chats"]()}
						depth={2}
						onclick={() => startChat(project)}
						title={m["nav.projects.start_chat"]()}
					/>
				{:else}
					<!-- The guide begins at the folder's disclosure-arrow centre. Its
					     padding plus the shared row's own padding leaves chat titles
					     aligned with the other depth-two leaves. -->
					<div
						class="ml-[1.375rem] flex flex-col gap-px border-l border-gray-200 pl-2.5 dark:border-gray-700"
					>
						{#each cache.chats[project.id] as conversation (conversation.id)}
							{@const sidebarConv = {
								id: conversation.id,
								title: convsStore?.titles[conversation.id] ?? conversation.title,
								model: conversation.model,
								projectId: project.id,
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
				{#if !chatsFailed[project.id] && cache.chats[project.id] !== undefined && (cache.others[project.id] ?? 0) > 0}
					<p
						class="ml-[1.375rem] px-2.5 py-1 text-xs text-gray-500 dark:text-gray-400"
						data-testid="project-others-count"
					>
						{m["projects.page.chats.others_count"]({ count: cache.others[project.id] })}
					</p>
				{/if}
			</TreeBranch>
		{/each}
	{/if}
</TreeBranch>

{#if deleting}
	{@const target = deleting}
	<DeleteProjectModal
		project={target}
		onclose={() => (deleting = null)}
		ondelete={(keepChats) => destroy(target, keepChats)}
	/>
{/if}
