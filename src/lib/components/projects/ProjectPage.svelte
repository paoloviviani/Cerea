<!--
	A project, as a page: `/projects/new` creates one, `/projects/<id>` is its page.

	This replaced an overlay with a form view inside it and a second Edit inside
	that. Everything that makes a project is one scroll of sections, each
	editable where it stands, and the sections are the project's **five context
	levels** in the order the prompt is built (`projectContext` in
	`$lib/server/projects`): standing instructions, context documents, project
	memory (all sent in full), then knowledge bases and past chats (searched).

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
	import { page } from "$app/state";
	import { webSearchUnavailableReason } from "$lib/utils/webSearchAvailability";
	import Switch from "$lib/components/Switch.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { projectsChanged } from "$lib/stores/projectsRevision";
	import {
		connectors as mcpConnectors,
		connectorsLoaded as mcpConnectorsLoaded,
		refreshConnectors as refreshMcpConnectors,
	} from "$lib/stores/mcpConnectors";
	import { GatewayError, gwGet, type BillableGroup, type VectorStore } from "$lib/gateway";
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
	let defaultConnectors = $state<string[]>([]);

	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");
	let kbSearch = $state("");

	const owned = $derived(creating || project?.owned === true);

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
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
		defaultConnectors = [...(from?.defaultMcpConnectorIds ?? [])];
	}

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
			failure = err instanceof Error ? err.message : "Could not open that project.";
		} finally {
			loading = false;
		}
		try {
			// The bases this person can reach, for the picker. Not fatal: a
			// project without knowledge bases is still a project.
			stores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
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
		try {
			await refreshMcpConnectors();
		} catch {
			/* the section reports the failure state from the store */
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
				defaultWebSearch !== (project.defaultWebSearch ?? $settings.webSearchEnabled === true) ||
				JSON.stringify(defaultConnectors) !== JSON.stringify(project.defaultMcpConnectorIds ?? []))
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
			defaultMcpConnectorIds: defaultConnectors,
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
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}

	function toggleDefaultConnector(connectorId: string) {
		defaultConnectors = defaultConnectors.includes(connectorId)
			? defaultConnectors.filter((entry) => entry !== connectorId)
			: [...defaultConnectors, connectorId];
	}

	// ---- knowledge bases: attached and detached at any time -----------------

	/** Named rather than dropped: a project quietly retrieving from fewer bases than it lists is what nobody debugs. */
	const attachedRows = $derived(
		attached.map((baseId) => ({
			id: baseId,
			name: stores.find((store) => store.id === baseId)?.name ?? "a base you can no longer read",
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
			failure = err instanceof Error ? err.message : "Could not change the knowledge bases.";
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
			if (!startModel) throw new Error("This deployment has no models available to you.");
			const response = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: startModel, projectId: project.id }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(parsed?.message ?? `Could not start a chat (${response.status}).`);
			}
			const { conversationId } = (await response.json()) as { conversationId: string };
			projectsChanged();
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start a chat.";
		} finally {
			busy = false;
		}
	}

	async function removeChat(conversation: ProjectConversation) {
		if (!project) return;
		if (
			!confirm(
				`Remove “${conversation.title}” from this project?\n\nThe chat is kept and goes back to the ordinary list; it stops using this project's context.`
			)
		)
			return;
		failure = null;
		try {
			await api(`/projects/${project.id}/conversations/${conversation.id}`, { method: "DELETE" });
			conversations = conversations.filter((entry) => entry.id !== conversation.id);
			project = { ...project, conversationCount: Math.max(0, project.conversationCount - 1) };
			projectsChanged();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not remove that chat.";
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
			notice =
				"Added. They see this project — and every conversation in it — next time they open Projects.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not share it.";
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
			failure = err instanceof Error ? err.message : "Could not remove that.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!project) return;
		if (
			!confirm(
				`Delete the project “${project.name}”?\n\nIts conversations and knowledge bases are kept — the chats go back to your ordinary list. Its notes and context documents are deleted with it.`
			)
		)
			return;
		const withMemory =
			project.hasMemory &&
			confirm(
				`Also delete “${project.name}” — past chats?\n\nThat is the searchable memory of this ` +
					"project's conversations. OK = delete the memory too. Cancel = keep the memory (the project is still deleted)."
			);
		busy = true;
		try {
			await api(`/projects/${project.id}${withMemory ? "?memory=delete" : ""}`, {
				method: "DELETE",
			});
			projectsChanged();
			await goto(`${base}/projects`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not delete it.";
			busy = false;
		}
	}

	const LEVELS = [
		{ title: "Standing instructions", how: "in full" },
		{ title: "Context documents", how: "in full" },
		{ title: "Project memory", how: "in full" },
		{ title: "Knowledge bases", how: "searched" },
		{ title: "Past chats", how: "searched" },
	] as const;
</script>

<div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
	<header class="flex flex-col gap-1">
		<a
			href="{base}/projects"
			class="flex w-fit items-center gap-1 text-xs text-ink-muted no-underline hover:text-ink"
		>
			<IconArrowLeft class="size-3" />
			All projects
		</a>
		<h1 class="text-xl font-semibold text-ink">
			{creating ? "New project" : (project?.name ?? "Project")}
		</h1>
		<p class={s.SUBTITLE}>
			{creating
				? "Give a group of chats the same instructions, documents and knowledge."
				: project?.description || "What it knows, what has been said, and who else can see it."}
		</p>
	</header>

	<div class="scrollbar-custom min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
		{#if failure}
			<p class="{s.ERROR} mb-4" role="alert">{failure}</p>
		{/if}

		{#if loading}
			<p class={s.SUBTITLE}>Loading…</p>
		{:else if !creating && !project}
			<div class={s.EMPTY}>
				<LucideFolderOpen class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>That project is not available</p>
				<p class={s.EMPTY_DETAIL}>It may have been deleted, or not shared with you.</p>
				<a href="{base}/projects" class={s.PRIMARY}>All projects</a>
			</div>
		{:else}
			<form
				class="grid grid-cols-1 items-start gap-5 pb-6 lg:grid-cols-2 [&>*]:min-w-0"
				onsubmit={save}
			>
				{#if project}
					<div class="{s.STRIP} {s.STRIP_ACTIVE} lg:col-span-2">
						<div class="flex items-center gap-3">
							<div class={s.STRIP_TILE}>
								<LucideFolderOpen class="size-5 text-accent" />
							</div>
							<div>
								<p class={s.STRIP_HEADLINE}>
									{project.conversationCount} conversation{project.conversationCount === 1
										? ""
										: "s"}
								</p>
								<p class={s.STRIP_DETAIL}>
									{#if knowledgeOn}
										{attached.length} knowledge base{attached.length === 1 ? "" : "s"}
										{#if project.indexPastChats}· past chats searchable{/if}
									{/if}
									{#if !project.owned}· shared with you{/if}
								</p>
							</div>
						</div>
						<button type="button" onclick={newChat} disabled={busy} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							New chat
						</button>
					</div>
				{/if}

				<section class="{s.TIPS} lg:col-span-2" aria-labelledby="project-levels">
					<h2 id="project-levels" class={s.TIPS_TITLE}>What every chat here is given</h2>
					<ol class="space-y-1 text-xs text-ink-muted">
						{#each LEVELS as level, index (level.title)}
							<li>
								{index + 1}. <strong class="text-ink">{level.title}</strong> —
								{level.how}{index < 3 ? ", on every message" : ", only what matches the question"}
							</li>
						{/each}
					</ol>
					<p class="mt-2 text-xs text-ink-muted">
						In that order. The first three are sent whole, so they cost on every message; the last
						two are searched, so only the passages that match what you ask arrive.
					</p>
				</section>

				<section class={s.card(false)}>
					<div class="space-y-4 p-4">
						<div>
							<label for="project-name" class={s.LABEL}>Name</label>
							<input
								id="project-name"
								class={s.INPUT}
								placeholder="Grant application"
								maxlength="128"
								bind:value={name}
								required
								disabled={busy || !owned}
							/>
						</div>
						<div>
							<label for="project-description" class={s.LABEL}>
								What it is for <span class="font-normal text-ink-faint">(optional)</span>
							</label>
							<input
								id="project-description"
								class={s.INPUT}
								maxlength="500"
								bind:value={description}
								disabled={busy || !owned}
							/>
						</div>
					</div>
				</section>

				<section class={s.card(false)}>
					<div class="p-4">
						<h2 class="{s.SECTION_TITLE} mb-1">
							<span class="{s.PILL} {s.PILL_TONES.busy}">1 · in full</span>
							Standing instructions
						</h2>
						<textarea
							id="project-instructions"
							aria-label="Standing instructions"
							class="{s.INPUT} min-h-28"
							placeholder="We are writing a Horizon Europe proposal. Answer in British English and cite the call text where it applies."
							bind:value={instructions}
							disabled={busy || !owned}
						></textarea>
						<p class={s.HINT}>Added to the system prompt of every conversation here.</p>
					</div>
				</section>

				{#if !creating && project}
					<section class={s.card(false)}>
						<div class="p-4">
							<span class="{s.PILL} {s.PILL_TONES.busy} mb-2">2 · in full</span>
							{#key project.id}
								<ProjectDocumentsSection projectId={project.id} />
							{/key}
						</div>
					</section>

					{#if memoryOn}
						<section class={s.card(false)}>
							<div class="p-4">
								<span class="{s.PILL} {s.PILL_TONES.busy} mb-2">3 · in full</span>
								{#key project.id}
									<ProjectMemorySection projectId={project.id} />
								{/key}
							</div>
						</section>
					{/if}
				{/if}

				{#if knowledgeOn}
					<section class={s.card(attached.length > 0)} data-testid="project-knowledge">
						<div class="p-4">
							<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
								<h2 class="{s.SECTION_TITLE} mb-0">
									<span class="{s.PILL} {s.PILL_TONES.busy}">4 · searched</span>
									Knowledge bases ({attached.length})
								</h2>
								<a href="{base}/workspace?tab=kb" class="text-xs text-accent">
									Create a base in the workspace
								</a>
							</div>

							{#if attachedRows.length === 0}
								<div class={s.EMPTY}>
									<LucideLibrary class={s.EMPTY_ICON} />
									<p class={s.EMPTY_TITLE}>No knowledge bases attached</p>
									<p class={s.EMPTY_DETAIL}>
										Attach one below and chats here can search it, now or any time later
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
													aria-label="Detach {row.name}"
													onclick={() => setAttached(attached.filter((entry) => entry !== row.id))}
												>
													<IconClose class="size-3" />
													Detach
												</button>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}

							{#if owned}
								<label for="project-kb-search" class={s.LABEL}>Attach a knowledge base</label>
								{#if stores.length === 0}
									<p class={s.HINT}>You have none yet. Create one in the workspace.</p>
								{:else}
									<input
										id="project-kb-search"
										type="search"
										class={s.SEARCH}
										placeholder="Search your knowledge bases"
										bind:value={kbSearch}
									/>
									<ul class="mt-2 max-h-52 space-y-1 overflow-y-auto">
										{#each candidates as store (store.id)}
											<li class="flex items-center justify-between gap-2 text-sm">
												<span class="min-w-0 truncate">
													{store.name}
													<span class="text-xs text-ink-faint">
														· {store.file_counts.completed} indexed{#if !store.owned}, shared with
															you{/if}
													</span>
												</span>
												<button
													type="button"
													class={s.CARD_ACTION}
													disabled={busy}
													aria-label="Attach {store.name}"
													onclick={() => setAttached([...attached, store.id])}
												>
													<IconAdd class="size-3" />
													Attach
												</button>
											</li>
										{:else}
											<li class={s.HINT}>
												{kbSearch.trim()
													? "No unattached base matches."
													: "Every base you can reach is attached."}
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
							<p class={s.HINT}>
								Sharing this project does <strong>not</strong> share these bases: each reader searches
								only the ones they can already read.
							</p>
						</div>
					</section>

					<section class={s.card(indexPastChats)}>
						<div class="space-y-3 p-4">
							<h2 class="{s.SECTION_TITLE} mb-0">
								<span class="{s.PILL} {s.PILL_TONES.busy}">5 · searched</span>
								Past chats
							</h2>
							<label class="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									bind:checked={indexPastChats}
									disabled={busy || !owned}
									class="mt-0.5 accent-blue-600"
								/>
								<span>
									Search this project's own past conversations
									<span class="block text-xs text-ink-muted">
										Finished exchanges go into a knowledge base of their own — it appears under
										Knowledge, and you can empty or delete it like any other. Off by default,
										because it copies what was said into a searchable store.
									</span>
								</span>
							</label>
							<div>
								<label for="project-limit" class={s.LABEL}>Passages per answer</label>
								<input
									id="project-limit"
									type="number"
									min="1"
									max="20"
									class="{s.INPUT} w-32"
									bind:value={retrievalLimit}
									disabled={busy || !owned}
								/>
								<p class={s.HINT}>Shared by knowledge bases and past chats.</p>
							</div>
						</div>
					</section>
				{/if}

				{#if !creating && project}
					<section class={s.card(false)}>
						<div class="p-4">
							<h2 class={s.SECTION_TITLE}>Chats ({conversations.length})</h2>
							{#if conversations.length === 0}
								<div class={s.EMPTY}>
									<IconChat class={s.EMPTY_ICON} />
									<p class={s.EMPTY_TITLE}>Nothing here yet</p>
									<p class={s.EMPTY_DETAIL}>Start one and it will carry this project's context</p>
									<button type="button" onclick={newChat} disabled={busy} class={s.PRIMARY}>
										<IconAddLarge class="size-4" />
										Start the First Chat
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
														{#if !conversation.mine}· somebody else's{/if}
													</span>
												</span>
											</a>
											{#if conversation.mine || project.owned}
												<button
													type="button"
													class={s.CARD_ACTION}
													aria-label="Remove {conversation.title} from project"
													onclick={() => removeChat(conversation)}
												>
													Remove from project
												</button>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</section>
				{/if}

				<section class={s.card(false)}>
					<div class="p-4">
						<h2 class={s.SECTION_TITLE}>Defaults for new chats here</h2>
						<div class="flex items-center gap-2">
							<Switch
								name="project-default-websearch"
								bind:checked={defaultWebSearch}
								disabled={busy || !owned || !!webSearchUnavailable}
							/>
							<span class="text-sm text-ink">Web search on by default</span>
						</div>
						{#if webSearchUnavailable}
							<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">{webSearchUnavailable}</p>
						{/if}
						<div class="mt-3">
							<span class="text-sm text-ink">MCPs on by default:</span>
							{#if !$mcpConnectorsLoaded}
								<p class={s.HINT}>Loading connectors…</p>
							{:else if $mcpConnectors.length === 0}
								<p class={s.HINT}>No connectors yet. Add one under Workspace → MCP Servers.</p>
							{:else}
								<div class="mt-1 max-h-40 space-y-1 overflow-y-auto">
									{#each $mcpConnectors as connector (connector.id)}
										<div class="flex items-center gap-2 text-sm">
											<Switch
												name={`project-default-connector-${connector.id}`}
												disabled={busy || !owned || !connector.connected}
												bind:checked={
													() => defaultConnectors.includes(connector.id),
													() => toggleDefaultConnector(connector.id)
												}
											/>
											<span>
												{connector.name}
												{#if !connector.connected}
													<span class="text-xs text-ink-faint">· not signed in</span>
												{/if}
											</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</section>

				{#if owned}
					<div
						class="sticky bottom-0 flex items-center justify-end gap-3 rounded-lg border border-line bg-surface px-3 py-2 lg:col-span-2"
					>
						{#if saved && !dirty}
							<span class="text-xs text-ok" role="status">Saved</span>
						{:else if dirty}
							<span class="text-xs text-ink-muted">Unsaved changes</span>
						{/if}
						<button
							type="submit"
							disabled={busy || !name.trim() || (!creating && !dirty)}
							class={s.PRIMARY}
						>
							{busy ? "Saving…" : creating ? "Create project" : "Save changes"}
						</button>
					</div>
				{/if}
			</form>

			{#if project?.owned}
				<section class="{s.card(false)} mb-6">
					<div class="p-4">
						<h2 class={s.SECTION_TITLE}>Share it</h2>
						<form class="flex flex-wrap items-end gap-2" onsubmit={share}>
							<div>
								<label for="project-share-kind" class={s.LABEL}>With</label>
								<select id="project-share-kind" class={s.INPUT} bind:value={shareKind}>
									<option value="user">A person</option>
									<option value="group">A group</option>
								</select>
							</div>
							<div class="min-w-48 flex-1">
								<label for="project-share-who" class={s.LABEL}>
									{shareKind === "user" ? "Their email address" : "Group name"}
								</label>
								{#if shareKind === "group" && groups.length > 0}
									<select id="project-share-who" class={s.INPUT} bind:value={shareWith}>
										<option value="">— choose —</option>
										{#each groups as group (group.id)}
											<option value={group.name}>{group.name}</option>
										{/each}
									</select>
								{:else}
									<input
										id="project-share-who"
										class={s.INPUT}
										placeholder={shareKind === "user" ? "colleague@example.org" : "research"}
										bind:value={shareWith}
									/>
								{/if}
							</div>
							<button type="submit" disabled={busy || !shareWith.trim()} class={s.PRIMARY}>
								<IconShare class="size-4" />
								Share
							</button>
						</form>

						{#if project.shares.length > 0}
							<ul class="mt-3 space-y-1">
								{#each project.shares as entry (entry.kind + entry.principal)}
									<li class="flex items-center justify-between gap-2 text-sm">
										<span class="min-w-0 truncate">
											{entry.principal}
											<span class="text-xs text-ink-faint">· {entry.kind}</span>
										</span>
										<button
											type="button"
											onclick={() => unshare(entry.kind, entry.principal)}
											disabled={busy}
											class={s.CARD_DESTRUCTIVE}
										>
											<IconTrash class="size-3" />
											Remove
										</button>
									</li>
								{/each}
							</ul>
						{/if}

						{#if notice}
							<p class="{s.NOTICE} mt-2">{notice}</p>
						{/if}
						<p class={s.HINT}>
							Everyone here sees <strong>every conversation</strong> in the project, including ones you
							did not start, and can add or remove its documents and notes. An address is not checked:
							a typo and a colleague who has not signed in yet look the same until they open it.
						</p>
						<div class="mt-4 flex justify-end">
							<button type="button" onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
								<IconTrash class="size-3" />
								Delete this project
							</button>
						</div>
					</div>
				</section>
			{:else if project}
				<p class="{s.HINT} mb-6">
					This project is shared with you. Its settings are the owner's; you can start chats, add
					documents and notes, and remove your own chats.
				</p>
			{/if}
		{/if}
	</div>
</div>
