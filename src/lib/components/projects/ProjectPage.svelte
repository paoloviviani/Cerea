<!--
	A project, as a page: `/projects/new` creates one, `/projects/<id>` is its page.

	This replaced an overlay with a form view inside it and a second Edit inside
	that. It is now two tabs of one page, addressed like the workspace panel
	(`?tab=settings`; anything else, a bare `/projects/<id>` included, is the
	conversations tab, and a query change never remounts the page):

	**Conversations** — the strip with the count and New chat, then the list of
	the project's chats, new and old. This is the tab the page opens on.

	**Settings** — everything that configures the project: the five context
	levels, each editable where it stands, in the order the prompt is built
	(`projectContext` in `$lib/server/projects`): standing instructions, context
	documents, project memory (all sent in full), then knowledge bases and past
	chats (searched) — plus the defaults for new chats, sharing and delete.

	Saving: the text fields and options share one Save (the bar appears when
	something changed); everything that is an *action* — attaching a base,
	adding or removing a document, a note, a chat, a share — happens at once,
	because there is nothing to review in it and unsaved attach state is how a
	base ends up looking attached when it is not.

	Three things this has to say out loud (ADR 0062), as the overlay did:

	**A shared project is a shared workspace.** Everyone who can see it sees
	every conversation in it, including ones other people started.

	**Sharing a project does not share its knowledge bases.** Retrieval
	re-checks the reader's own access to every attached base on every turn.

	**A share names an address, not a person.** Nothing resolves it.

	Loads in `onMount`, not the component body: this renders as a page, and a
	page body runs on the server, where a relative fetch has no origin.
-->
<script lang="ts">
	import { modelLabel } from "$lib/utils/customModelEntries";
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import { page } from "$app/state";
	import { webSearchUnavailableReason } from "$lib/utils/webSearchAvailability";
	import Switch from "$lib/components/Switch.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { projectsChanged } from "$lib/stores/projectsRevision";
	import MoveMenu from "$lib/components/MoveMenu.svelte";
	import MoveToProjectModal from "$lib/components/MoveToProjectModal.svelte";
	import DeleteConversationModal from "$lib/components/DeleteConversationModal.svelte";
	import { useMoveConversation } from "$lib/utils/useMoveConversation";
	import { projectTitle } from "$lib/stores/projectTitle";
	import { GatewayError, gwGet, type BillableGroup, type VectorStore } from "$lib/gateway";
	import SettingsShell from "$lib/components/settings/SettingsShell.svelte";
	import SettingsGroup from "$lib/components/settings/SettingsGroup.svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import ProjectMemorySection from "./ProjectMemorySection.svelte";
	import ProjectDocumentsSection from "./ProjectDocumentsSection.svelte";
	import type { ProjectView } from "$lib/types/Project";
	import * as s from "$lib/components/overlay/styles";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconAdd from "~icons/carbon/add";
	import IconTrash from "~icons/carbon/trash-can";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconShare from "~icons/carbon/share";
	import IconChat from "~icons/carbon/chat";
	import IconSettings from "~icons/carbon/settings";
	import IconClose from "~icons/carbon/close";
	import LucideFolderOpen from "~icons/lucide/folder-open";
	import LucideLibrary from "~icons/lucide/library";

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
		mine: boolean;
	}

	interface Props {
		/** The project's id; absent on `/projects/new`. */
		id?: string;
	}

	let { id }: Props = $props();

	const settings = useSettingsStore();

	// The deployment switches (FeatureFlags): off hides what has nothing behind it.
	const knowledgeOn = $derived(
		(page.data as { knowledgeEnabled?: boolean }).knowledgeEnabled !== false
	);
	const memoryOn = $derived((page.data as { memoryEnabled?: boolean }).memoryEnabled !== false);
	const webSearchUnavailable = $derived(
		webSearchUnavailableReason(
			page.data as { webSearchAvailable?: boolean; gatewayIsAdmin?: boolean }
		)
	);

	const catalogue = $derived(
		(page.data.models ?? []) as {
			id: string;
			displayName?: string;
			customBase?: { displayName: string };
		}[]
	);
	/** A chat's model as people know it: a custom model reads "name · base". */
	const modelName = (id: string) => {
		const model = catalogue.find((entry) => entry.id === id);
		return model ? modelLabel({ ...model, id }) : id;
	};
	const startModel = $derived(
		catalogue.some((model) => model.id === $settings.activeModel)
			? $settings.activeModel
			: catalogue[0]?.id
	);

	// Read once: which page this is does not change under the component (the
	// route remounts it per address).
	// svelte-ignore state_referenced_locally
	const creating = id === undefined;

	let project = $state<ProjectView | null>(null);
	let conversations = $state<ProjectConversation[]>([]);
	let stores = $state<VectorStore[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let loading = $state(!creating);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let saved = $state(false);

	// The editable fields.
	let name = $state("");
	let description = $state("");
	let instructions = $state("");
	let attached = $state<string[]>([]);
	let indexPastChats = $state(false);
	let retrievalLimit = $state("6");
	let defaultWebSearch = $state(false);

	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");
	let kbSearch = $state("");

	const owned = $derived(creating || project?.owned === true);

	/**
	 * The tab and the address are one thing, as in the workspace panel:
	 * `?tab=settings` opens the settings, anything else — a bare
	 * `/projects/<id>`, a mistyped value — opens the conversations. A query
	 * change is not a new address, so the switch never remounts this
	 * component: the loaded project, the loaded sections and any unsaved
	 * edits all survive it.
	 */
	const TABS = [
		{ key: "conversations", label: m["projects.page.tab.conversations"] },
		{ key: "settings", label: m["projects.page.tab.settings"] },
	] as const;
	type TabKey = (typeof TABS)[number]["key"];
	const tab = $derived(
		TABS.find((candidate) => candidate.key === page.url.searchParams.get("tab"))?.key ??
			("conversations" satisfies TabKey)
	);

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["projects.page.error_status"]({ status: response.status })
			);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	function json(body: unknown, method = "POST") {
		return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	}

	function seed(from: ProjectView | null) {
		name = from?.name ?? "";
		description = from?.description ?? "";
		instructions = from?.instructions ?? "";
		attached = [...(from?.knowledgeBaseIds ?? [])];
		indexPastChats = from?.indexPastChats ?? false;
		retrievalLimit = String(from?.retrievalLimit ?? 6);
		// An explicit stored value wins; otherwise seed from the app default so a
		// new project (or an old doc without the field) starts where new chats
		// would anyway. Saved back as an explicit boolean.
		defaultWebSearch =
			typeof from?.defaultWebSearch === "boolean"
				? from.defaultWebSearch
				: $settings.webSearchEnabled === true;
	}

	// The phone's top bar names the project instead of "New Chat".
	$effect(() => {
		projectTitle.set(project?.name ?? "");
		return () => projectTitle.set("");
	});

	onMount(async () => {
		if (creating) seed(null);
		try {
			if (!creating) {
				const [detail, listed] = await Promise.all([
					api<ProjectView>(`/projects/${id}`),
					api<{ data: ProjectConversation[] }>(`/projects/${id}/conversations`),
				]);
				project = detail;
				conversations = listed.data;
				seed(detail);
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.open_failed"]();
		} finally {
			loading = false;
		}
		try {
			// The bases this person can reach, for the picker. Not fatal: a
			// project without knowledge bases is still a project.
			// A project's own past-chat index is listed too; it is never
			// attachable (server refuses it), so it is not offered.
			stores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data.filter(
				(store) => !store.memory_of
			);
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
		}
		if (!creating) {
			try {
				groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
			} catch {
				/* a convenience: the group field falls back to free text */
			}
		}
	});

	// ---- saving -------------------------------------------------------------

	const dirty = $derived(
		!creating &&
			project !== null &&
			(name.trim() !== project.name ||
				description.trim() !== project.description ||
				instructions !== project.instructions ||
				indexPastChats !== project.indexPastChats ||
				(Number(retrievalLimit) || 6) !== project.retrievalLimit ||
				defaultWebSearch !== (project.defaultWebSearch ?? $settings.webSearchEnabled === true))
	);

	function fields() {
		return {
			name: name.trim(),
			description: description.trim(),
			instructions,
			knowledgeBaseIds: attached,
			indexPastChats,
			retrievalLimit: Number(retrievalLimit) || 6,
			defaultWebSearch,
		};
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim() || !owned) return;
		busy = true;
		failure = null;
		saved = false;
		try {
			if (creating) {
				const created = await api<ProjectView>("/projects", json(fields()));
				projectsChanged();
				await goto(`${base}/projects/${created.id}`, { replaceState: true });
			} else {
				project = await api<ProjectView>(`/projects/${id}`, json(fields(), "PATCH"));
				seed(project);
				saved = true;
				projectsChanged();
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.save_failed"]();
		} finally {
			busy = false;
		}
	}

	// ---- knowledge bases: attached and detached at any time -----------------

	/** Named rather than dropped: a project quietly retrieving from fewer bases than it lists is what nobody debugs. */
	const attachedRows = $derived(
		attached.map((baseId) => ({
			id: baseId,
			name: stores.find((store) => store.id === baseId)?.name ?? m["projects.page.kb.unreadable"](),
		}))
	);
	const candidates = $derived(
		stores
			.filter((store) => !attached.includes(store.id))
			.filter((store) => store.name.toLowerCase().includes(kbSearch.trim().toLowerCase()))
	);

	async function setAttached(next: string[]) {
		if (!owned) return;
		const before = attached;
		attached = next;
		if (creating) return;
		busy = true;
		failure = null;
		try {
			project = await api<ProjectView>(
				`/projects/${id}`,
				json({ knowledgeBaseIds: next }, "PATCH")
			);
			projectsChanged();
		} catch (err) {
			attached = before;
			failure = err instanceof Error ? err.message : m["projects.page.kb.change_failed"]();
		} finally {
			busy = false;
		}
	}

	// ---- chats ----------------------------------------------------------------

	async function newChat() {
		if (!project) return;
		busy = true;
		failure = null;
		try {
			if (!startModel) throw new Error(m["projects.page.no_models"]());
			const response = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: startModel, projectId: project.id }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(
					parsed?.message ?? m["projects.page.chat_start_status"]({ status: response.status })
				);
			}
			const { conversationId } = (await response.json()) as { conversationId: string };
			projectsChanged();
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.chat_start_failed"]();
		} finally {
			busy = false;
		}
	}

	const moveConversation = useMoveConversation();
	let moving = $state<ProjectConversation | null>(null);
	let deleting = $state<ProjectConversation | null>(null);

	/** The chat is no longer in this project: drop its row and count. */
	function leftProject(conversation: ProjectConversation) {
		if (!project) return;
		conversations = conversations.filter((entry) => entry.id !== conversation.id);
		project = { ...project, conversationCount: Math.max(0, project.conversationCount - 1) };
	}

	/**
	 * Take a chat out of the project. No confirmation: the chat is kept, and
	 * moving it back in (the row's menu, or a drag in the sidebar) restores it;
	 * the toast says what happened.
	 */
	async function removeChat(conversation: ProjectConversation) {
		if (!project) return;
		failure = null;
		const ok = await moveConversation(
			{ id: conversation.id, title: conversation.title, model: conversation.model },
			null,
			project.name
		);
		if (ok) leftProject(conversation);
	}

	/**
	 * Delete one of the person's own chats, with the same confirmation modal
	 * the sidebar's row menu uses and the same endpoint. Offered for the
	 * author's chats only: the server's delete is the caller's own anyway.
	 */
	async function deleteChat(conversation: ProjectConversation) {
		failure = null;
		try {
			await api(`/conversations/${conversation.id}`, { method: "DELETE" });
			leftProject(conversation);
			projectsChanged();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["nav.projects.delete_chat_failed"]();
		}
	}

	// ---- sharing and deleting -------------------------------------------------

	async function share(event: SubmitEvent) {
		event.preventDefault();
		if (!project || !shareWith.trim()) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			project = await api<ProjectView>(
				`/projects/${project.id}/shares`,
				json(
					shareKind === "user"
						? { kind: "user", email: shareWith.trim() }
						: { kind: "group", name: shareWith.trim() }
				)
			);
			shareWith = "";
			notice = m["projects.page.share.added"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.share.failed"]();
		} finally {
			busy = false;
		}
	}

	async function unshare(kind: "user" | "group", principal: string) {
		if (!project) return;
		busy = true;
		try {
			project = await api<ProjectView>(
				`/projects/${project.id}/shares?kind=${kind}&principal=${encodeURIComponent(principal)}`,
				{ method: "DELETE" }
			);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.share.remove_failed"]();
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!project) return;
		if (!confirm(m["projects.page.delete.confirm"]({ name: project.name }))) return;
		const withMemory =
			project.hasMemory &&
			confirm(m["projects.page.delete.confirm_memory"]({ name: project.name }));
		busy = true;
		try {
			await api(`/projects/${project.id}${withMemory ? "?memory=delete" : ""}`, {
				method: "DELETE",
			});
			projectsChanged();
			await goto(`${base}/projects`);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.page.delete.failed"]();
			busy = false;
		}
	}

	/** The settings tab's index: the groups, and the numbered levels under them. */
	const settingsIndex = $derived([
		{ id: "project-group-full", label: m["projects.page.group.full"]() },
		{
			id: "project-level-1",
			label: m["projects.page.index.level"]({
				n: 1,
				title: m["projects.page.level.instructions"](),
			}),
			nested: true,
		},
		...(!creating && project
			? [
					{
						id: "project-level-2",
						label: m["projects.page.index.level"]({
							n: 2,
							title: m["projects.page.level.files"](),
						}),
						nested: true,
					},
					...(memoryOn
						? [
								{
									id: "project-level-3",
									label: m["projects.page.index.level"]({
										n: 3,
										title: m["projects.page.level.notes"](),
									}),
									nested: true,
								},
							]
						: []),
				]
			: []),
		...(knowledgeOn
			? [
					{ id: "project-group-searched", label: m["projects.page.group.searched"]() },
					{
						id: "project-level-4",
						label: m["projects.page.index.level"]({
							n: 4,
							title: m["projects.page.level.knowledge"](),
						}),
						nested: true,
					},
					{
						id: "project-level-5",
						label: m["projects.page.index.level"]({
							n: 5,
							title: m["projects.page.level.past_chats"](),
						}),
						nested: true,
					},
				]
			: []),
		{ id: "project-group-new", label: m["projects.page.group.new_chats"]() },
		...(project?.owned ? [{ id: "project-danger", label: m["projects.page.danger.title"]() }] : []),
	]);
</script>

{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}

{#if moving}
	<MoveToProjectModal
		chat={{ id: moving.id, title: moving.title, model: moving.model, projectId: project?.id }}
		onclose={() => (moving = null)}
		onmoved={() => moving && leftProject(moving)}
	/>
{/if}

{#if deleting}
	<DeleteConversationModal
		open={true}
		title={deleting.title}
		onclose={() => (deleting = null)}
		ondelete={() => {
			const target = deleting;
			deleting = null;
			if (target) void deleteChat(target);
		}}
	/>
{/if}

<div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
	<header class="flex flex-col gap-1">
		<a
			href="{base}/projects"
			class="flex w-fit items-center gap-1 text-xs text-ink-muted no-underline hover:text-ink"
		>
			<IconArrowLeft class="size-3" />
			{m["projects.page.all"]()}
		</a>
		<h1 class="text-xl font-semibold text-ink">
			{creating
				? m["projects.page.new_title"]()
				: (project?.name ?? m["projects.page.fallback_title"]())}
		</h1>
		<p class={s.SUBTITLE}>
			{creating
				? m["projects.page.new_subtitle"]()
				: project?.description || m["projects.page.subtitle"]()}
		</p>
	</header>

	{#if !creating && project}
		<!--
			The same tab bar the workspace, settings and admin pages draw: a row of
			links under a shared border, the active one marked `aria-current`.
			Hidden until the project has loaded, and absent from /projects/new,
			which has nothing to tab between yet.
		-->
		<nav
			aria-label={m["projects.page.sections_label"]()}
			class="flex flex-wrap gap-0.5 border-b border-gray-200 sm:gap-1 dark:border-gray-700"
		>
			{#each TABS as t (t.key)}
				{@const active = tab === t.key}
				<a
					href={t.key === "conversations"
						? `${base}/projects/${id}`
						: `${base}/projects/${id}?tab=${t.key}`}
					aria-current={active ? "page" : undefined}
					class="flex items-center gap-1 rounded-t-lg border-b-2 px-2 py-1.5 text-xs font-medium transition-colors sm:gap-1.5 sm:px-3 sm:py-2 sm:text-sm {active
						? 'border-blue-600 text-blue-700 dark:text-blue-400'
						: 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
				>
					{#if t.key === "conversations"}
						<IconChat class="size-3.5 sm:size-4" />
					{:else}
						<IconSettings class="size-3.5 sm:size-4" />
					{/if}
					{t.label()}
				</a>
			{/each}
		</nav>
	{/if}

	<div class="scrollbar-custom min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
		{#if failure}
			<p class="{s.ERROR} mb-4" role="alert">{failure}</p>
		{/if}

		{#if loading}
			<p class={s.SUBTITLE}>{m["projects.page.loading"]()}</p>
		{:else if !creating && !project}
			<div class={s.EMPTY}>
				<LucideFolderOpen class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>{m["projects.page.missing.title"]()}</p>
				<p class={s.EMPTY_DETAIL}>{m["projects.page.missing.detail"]()}</p>
				<a href="{base}/projects" class={s.PRIMARY}>{m["projects.page.all"]()}</a>
			</div>
		{:else if creating || tab === "settings"}
			<!--
				The settings tab (and the whole of /projects/new, which has no
				conversations to tab between yet): one column in the order the
				prompt is built, the Save bar, then the danger zone. The text
				fields belong to the form below by its id rather than by nesting,
				because the share form sits beside the defaults, in the same
				column, and forms do not nest.
			-->
			<form id="project-form" onsubmit={save}></form>
			<SettingsShell index={settingsIndex} indexLabel={m["projects.page.index.label"]()}>
				<div class="space-y-4">
					<div>
						<label for="project-name" class={s.LABEL}>{m["projects.page.name.label"]()}</label>
						<input
							id="project-name"
							form="project-form"
							class={s.INPUT}
							placeholder={m["projects.page.name.placeholder"]()}
							maxlength="128"
							bind:value={name}
							required
							disabled={busy || !owned}
						/>
					</div>
					<div>
						<label for="project-description" class={s.LABEL}>
							{m["projects.page.description.label"]()}
							<span class="font-normal text-ink-faint">{m["projects.page.optional"]()}</span>
						</label>
						<input
							id="project-description"
							form="project-form"
							class={s.INPUT}
							maxlength="500"
							bind:value={description}
							disabled={busy || !owned}
						/>
					</div>
				</div>

				<SettingsGroup
					id="project-group-full"
					title={m["projects.page.group.full"]()}
					note={m["projects.page.group.full_note"]()}
				>
					<SettingsSection
						id="project-level-1"
						pill={m["projects.page.pill.full"]({ n: 1 })}
						title={m["projects.page.level.instructions"]()}
					>
						<textarea
							id="project-instructions"
							form="project-form"
							aria-label={m["projects.page.level.instructions"]()}
							class="{s.INPUT} min-h-28"
							placeholder={m["projects.page.instructions.placeholder"]()}
							bind:value={instructions}
							disabled={busy || !owned}
						></textarea>
						<p class={s.HINT}>{m["projects.page.instructions.hint"]()}</p>
					</SettingsSection>

					{#if !creating && project}
						<SettingsSection id="project-level-2" pill={m["projects.page.pill.full"]({ n: 2 })}>
							{#key project.id}
								<ProjectDocumentsSection projectId={project.id} />
							{/key}
						</SettingsSection>

						{#if memoryOn}
							<SettingsSection id="project-level-3" pill={m["projects.page.pill.full"]({ n: 3 })}>
								{#key project.id}
									<ProjectMemorySection projectId={project.id} />
								{/key}
							</SettingsSection>
						{/if}
					{/if}
				</SettingsGroup>

				{#if knowledgeOn}
					<SettingsGroup
						id="project-group-searched"
						title={m["projects.page.group.searched"]()}
						note={m["projects.page.group.searched_note"]()}
					>
						<SettingsSection
							id="project-level-4"
							testid="project-knowledge"
							active={attached.length > 0}
							pill={m["projects.page.pill.searched"]({ n: 4 })}
							title={m["projects.page.kb.title"]({ count: attached.length })}
						>
							{#snippet actions()}
								<a href="{base}/workspace?tab=kb" class="text-xs text-accent">
									{m["projects.page.kb.create"]()}
								</a>
							{/snippet}
							{#if attachedRows.length === 0}
								<div class={s.EMPTY}>
									<LucideLibrary class={s.EMPTY_ICON} />
									<p class={s.EMPTY_TITLE}>{m["projects.page.kb.none.title"]()}</p>
									<p class={s.EMPTY_DETAIL}>
										{m["projects.page.kb.none.detail"]()}
									</p>
								</div>
							{:else}
								<ul class="mb-3 space-y-1.5">
									{#each attachedRows as row (row.id)}
										<li
											class="flex items-center justify-between gap-2 rounded-lg bg-accent-subtle px-3 py-1.5 text-sm"
										>
											<span class="min-w-0 truncate">{row.name}</span>
											{#if owned}
												<button
													type="button"
													class={s.CARD_ACTION}
													disabled={busy}
													aria-label={m["projects.page.kb.detach_label"]({ name: row.name })}
													onclick={() => setAttached(attached.filter((entry) => entry !== row.id))}
												>
													<IconClose class="size-3" />
													{m["projects.page.kb.detach"]()}
												</button>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}

							{#if owned}
								<label for="project-kb-search" class={s.LABEL}
									>{m["projects.page.kb.attach_label"]()}</label
								>
								{#if stores.length === 0}
									<p class={s.HINT}>{m["projects.page.kb.you_have_none"]()}</p>
								{:else}
									<input
										id="project-kb-search"
										type="search"
										class={s.SEARCH}
										placeholder={m["projects.page.kb.search"]()}
										bind:value={kbSearch}
									/>
									<ul class="mt-2 max-h-52 space-y-1 overflow-y-auto">
										{#each candidates as store (store.id)}
											<li class="flex items-center justify-between gap-2 text-sm">
												<span class="min-w-0 truncate">
													{store.name}
													<span class="text-xs text-ink-faint">
														{store.owned
															? m["projects.page.kb.ready"]({ count: store.file_counts.completed })
															: m["projects.page.kb.ready_shared"]({
																	count: store.file_counts.completed,
																})}
													</span>
												</span>
												<button
													type="button"
													class={s.CARD_ACTION}
													disabled={busy}
													aria-label={m["projects.page.kb.attach_name_label"]({ name: store.name })}
													onclick={() => setAttached([...attached, store.id])}
												>
													<IconAdd class="size-3" />
													{m["projects.page.kb.attach"]()}
												</button>
											</li>
										{:else}
											<li class={s.HINT}>
												{kbSearch.trim()
													? m["projects.page.kb.no_match"]()
													: m["projects.page.kb.all_attached"]()}
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
							<p class={s.HINT}>
								<Rich parts={m["projects.page.kb.sharing_note"].parts({})} tags={{ strong }} />
							</p>
						</SettingsSection>

						<SettingsSection
							id="project-level-5"
							active={indexPastChats}
							pill={m["projects.page.pill.searched"]({ n: 5 })}
							title={m["projects.page.level.past_chats"]()}
						>
							<div class="space-y-3">
								<label class="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										form="project-form"
										bind:checked={indexPastChats}
										disabled={busy || !owned}
										class="mt-0.5 accent-blue-600"
									/>
									<span>
										{m["projects.page.past.label"]()}
										<span class="block text-xs text-ink-muted">
											{m["projects.page.past.detail"]()}
										</span>
									</span>
								</label>
								<div>
									<label for="project-limit" class={s.LABEL}
										>{m["projects.page.limit.label"]()}</label
									>
									<input
										id="project-limit"
										form="project-form"
										type="number"
										min="1"
										max="20"
										class="{s.INPUT} w-32"
										bind:value={retrievalLimit}
										disabled={busy || !owned}
									/>
									<p class={s.HINT}>{m["projects.page.limit.hint"]()}</p>
								</div>
							</div>
						</SettingsSection>
					</SettingsGroup>
				{/if}

				<SettingsGroup id="project-group-new" title={m["projects.page.group.new_chats"]()}>
					<div class="grid items-start gap-4 lg:grid-cols-2 [&>*]:min-w-0">
						<SettingsSection title={m["projects.page.defaults.title"]()}>
							<div class="flex items-center gap-2">
								<Switch
									name="project-default-websearch"
									bind:checked={defaultWebSearch}
									disabled={busy || !owned || !!webSearchUnavailable}
								/>
								<span class="text-sm text-ink">{m["projects.page.defaults.web_search"]()}</span>
							</div>
							{#if webSearchUnavailable}
								<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
									{webSearchUnavailable}
								</p>
							{/if}
						</SettingsSection>

						{#if project?.owned}
							<SettingsSection id="project-share" title={m["projects.page.share.title"]()}>
								<form class="flex flex-wrap items-end gap-2" onsubmit={share}>
									<div>
										<label for="project-share-kind" class={s.LABEL}
											>{m["projects.page.share.with"]()}</label
										>
										<select id="project-share-kind" class={s.INPUT} bind:value={shareKind}>
											<option value="user">{m["projects.page.share.person"]()}</option>
											<option value="group">{m["projects.page.share.group"]()}</option>
										</select>
									</div>
									<div class="min-w-48 flex-1">
										<label for="project-share-who" class={s.LABEL}>
											{shareKind === "user"
												? m["projects.page.share.email"]()
												: m["projects.page.share.group_name"]()}
										</label>
										{#if shareKind === "group" && groups.length > 0}
											<select id="project-share-who" class={s.INPUT} bind:value={shareWith}>
												<option value="">{m["projects.page.share.choose"]()}</option>
												{#each groups as group (group.id)}
													<option value={group.name}>{group.name}</option>
												{/each}
											</select>
										{:else}
											<input
												id="project-share-who"
												class={s.INPUT}
												placeholder={shareKind === "user"
													? m["projects.page.share.email_placeholder"]()
													: m["projects.page.share.group_placeholder"]()}
												bind:value={shareWith}
											/>
										{/if}
									</div>
									<button type="submit" disabled={busy || !shareWith.trim()} class={s.PRIMARY}>
										<IconShare class="size-4" />
										{m["projects.page.share.button"]()}
									</button>
								</form>

								{#if project.shares.length > 0}
									<ul class="mt-3 space-y-1">
										{#each project.shares as entry (entry.kind + entry.principal)}
											<li class="flex items-center justify-between gap-2 text-sm">
												<span class="min-w-0 truncate">
													{entry.principal}
													<span class="text-xs text-ink-faint">
														{entry.kind === "user"
															? m["projects.page.share.kind_user"]()
															: m["projects.page.share.kind_group"]()}
													</span>
												</span>
												<button
													type="button"
													onclick={() => unshare(entry.kind, entry.principal)}
													disabled={busy}
													class={s.CARD_DESTRUCTIVE}
												>
													<IconTrash class="size-3" />
													{m["projects.page.share.remove"]()}
												</button>
											</li>
										{/each}
									</ul>
								{/if}

								{#if notice}
									<p class="{s.NOTICE} mt-2">{notice}</p>
								{/if}
								<p class={s.HINT}>
									<Rich parts={m["projects.page.share.note"].parts({})} tags={{ strong }} />
								</p>
							</SettingsSection>
						{:else if project}
							<p class="{s.HINT} mb-6">
								{m["projects.page.shared_note"]()}
							</p>
						{/if}
					</div>
				</SettingsGroup>

				{#if owned}
					<div
						class="sticky bottom-0 -mt-4 flex items-center justify-end gap-3 rounded-lg border border-line bg-surface px-3 py-2"
					>
						{#if saved && !dirty}
							<span class="text-xs text-ok" role="status">{m["projects.page.saved"]()}</span>
						{:else if dirty}
							<span class="text-xs text-ink-muted">{m["projects.page.unsaved"]()}</span>
						{/if}
						<button
							type="submit"
							form="project-form"
							disabled={busy || !name.trim() || (!creating && !dirty)}
							class={s.PRIMARY}
						>
							{busy
								? m["projects.page.saving"]()
								: creating
									? m["projects.page.create"]()
									: m["projects.page.save_changes"]()}
						</button>
					</div>
				{/if}

				{#if project?.owned}
					<section
						id="project-danger"
						aria-labelledby="project-danger-title"
						class="scroll-mt-2 rounded-lg border border-red-300 p-4 pb-4 dark:border-red-900/60"
					>
						<h2
							id="project-danger-title"
							class="mb-3 text-base font-semibold text-red-700 dark:text-red-400"
						>
							{m["projects.page.danger.title"]()}
						</h2>
						<button type="button" onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
							<IconTrash class="size-3" />
							{m["projects.page.delete.button"]()}
						</button>
					</section>
				{/if}
			</SettingsShell>
		{:else}
			<!--
				The conversations tab: the strip with the count and the New chat
				action, then the list. Nothing here is a form field, so this branch
				is outside the settings form entirely.
			-->
			{#if project}
				<div class="flex flex-col gap-5 pb-6">
					<div class="{s.STRIP} {s.STRIP_ACTIVE}">
						<div class="flex items-center gap-3">
							<div class={s.STRIP_TILE}>
								<LucideFolderOpen class="size-5 text-accent" />
							</div>
							<div>
								<p class={s.STRIP_HEADLINE}>
									{m["projects.page.chats.count"]({ count: project.conversationCount })}
								</p>
								<p class={s.STRIP_DETAIL}>
									{#if knowledgeOn}
										{m["projects.page.chats.bases"]({ count: attached.length })}
										{#if project.indexPastChats}{m["projects.page.chats.past_searchable"]()}{/if}
									{/if}
									{#if !project.owned}{m["projects.page.chats.shared"]()}{/if}
								</p>
							</div>
						</div>
						<button type="button" onclick={newChat} disabled={busy} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							{m["projects.page.chats.new"]()}
						</button>
					</div>

					<section class={s.card(false)}>
						<div class="p-4">
							<h2 class={s.SECTION_TITLE}>
								{m["projects.page.chats.title"]({ count: conversations.length })}
							</h2>
							{#if conversations.length === 0}
								<div class={s.EMPTY}>
									<IconChat class={s.EMPTY_ICON} />
									<p class={s.EMPTY_TITLE}>{m["projects.page.chats.empty.title"]()}</p>
									<p class={s.EMPTY_DETAIL}>
										{m["projects.page.chats.empty.detail"]()}
									</p>
									<button type="button" onclick={newChat} disabled={busy} class={s.PRIMARY}>
										<IconAddLarge class="size-4" />
										{m["projects.page.chats.empty.start"]()}
									</button>
								</div>
							{:else}
								<ul class="space-y-2">
									{#each conversations as conversation (conversation.id)}
										<li class="{s.card(false)} flex items-center gap-2 pr-3">
											<a
												href="{base}/conversation/{conversation.id}"
												class="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 no-underline"
											>
												<IconChat class="size-4 flex-shrink-0 text-ink-faint" />
												<span class="min-w-0 flex-1">
													<span class="block truncate text-sm font-medium"
														>{conversation.title}</span
													>
													<span class="text-xs text-ink-muted">
														{modelName(conversation.model)}
														{#if !conversation.mine}{m["projects.page.chats.others"]()}{/if}
													</span>
												</span>
											</a>
											<!-- Moving a chat is its author's alone; the project's
											     owner may only take a member's chat out. -->
											{#if conversation.mine || project.owned}
												<MoveMenu
													label={conversation.title}
													onmove={conversation.mine ? () => (moving = conversation) : undefined}
													onremove={() => removeChat(conversation)}
													ondelete={conversation.mine ? () => (deleting = conversation) : undefined}
												/>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</section>
				</div>
			{/if}
		{/if}
	</div>
</div>
