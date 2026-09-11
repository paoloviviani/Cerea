<!--
	Projects, as an overlay in this app's own dialog language.

	Three views in one dialog: the list, the form that creates or edits one, and
	one project with its conversations and its sharing. Starting a chat is the
	one action that leaves the dialog, because that is the point of it.

	Three things this has to say out loud, because all three are deliberate and
	all three surprise people (ADR 0062).

	**A shared project is a shared workspace.** Everyone who can see it sees
	every conversation in it, including ones other people started.

	**Sharing a project does not share its knowledge bases.** Retrieval
	re-checks the reader's own access to every attached base on every turn.

	**A share names an address, not a person.** Nothing resolves it: a typo and
	a colleague who has not signed in yet look identical until somebody with
	that address opens the project.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import Modal from "$lib/components/Modal.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import { GatewayError, gwGet, type BillableGroup, type VectorStore } from "$lib/gateway";
	import type { ProjectView } from "$lib/types/Project";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconTrash from "~icons/carbon/trash-can";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconShare from "~icons/carbon/share";
	import IconSettings from "~icons/carbon/settings";
	import IconChat from "~icons/carbon/chat";
	import LucideFolderOpen from "~icons/lucide/folder-open";
	import * as s from "$lib/components/overlay/styles";

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
		mine: boolean;
	}

	interface Props {
		/** Open straight onto one project, for `/projects/<id>` and the tree. */
		initialId?: string;
		/**
		 * `"create"` opens the form directly, for the `+` on the tree's Projects
		 * row. With either this or `initialId` the dialog is about **one**
		 * project and the route back to the list is hidden: the sidebar tree
		 * already lists them, with per-row management.
		 */
		initialView?: "create";
		onclose: () => void;
	}

	let { initialId, initialView, onclose }: Props = $props();

	const settings = useSettingsStore();

	// The same choice the home page makes: this person's active model if it is
	// still one of the deployment's, the first otherwise.
	const catalogue = $derived((page.data.models ?? []) as { id: string }[]);
	const startModel = $derived(
		catalogue.some((model) => model.id === $settings.activeModel)
			? $settings.activeModel
			: catalogue[0]?.id
	);

	type View = "list" | "form" | "detail";
	// Read once: these are how the dialog was opened, not props that change
	// under it. A `$derived` here would drag somebody back to the detail view
	// every time they navigated inside the dialog.
	let view = $state<View>(
		untrack(() => (initialId ? "detail" : initialView === "create" ? "form" : "list"))
	);
	/** Opened about one project, so the list is not part of this dialog. */
	const single = untrack(() => Boolean(initialId) || initialView === "create");

	let projects = $state<ProjectView[]>([]);
	let stores = $state<VectorStore[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);

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

	async function load() {
		failure = null;
		try {
			projects = (await api<{ data: ProjectView[] }>("/projects")).data;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load projects.";
		} finally {
			loading = false;
		}
		try {
			// The bases this person can reach, for the form's checklist. Not fatal:
			// a project without knowledge bases is still a project.
			stores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
		}
	}

	// `onMount`, not the component body: these managers are also rendered as
	// pages (`/knowledge`, `/agents`, `/projects`), and a page body runs on the
	// server, where a relative fetch has no origin to resolve against.
	onMount(() =>
		load().then(() => {
			if (initialId) void openDetail(initialId);
		})
	);

	// ---- the form, for create and for edit ---------------------------------

	let editing = $state<ProjectView | null>(null);
	let name = $state("");
	let description = $state("");
	let instructions = $state("");
	let attached = $state<string[]>([]);
	let indexPastChats = $state(false);
	let retrievalLimit = $state("6");

	function openForm(project: ProjectView | null) {
		editing = project;
		name = project?.name ?? "";
		description = project?.description ?? "";
		instructions = project?.instructions ?? "";
		attached = [...(project?.knowledgeBaseIds ?? [])];
		indexPastChats = project?.indexPastChats ?? false;
		retrievalLimit = String(project?.retrievalLimit ?? 6);
		failure = null;
		notice = null;
		view = "form";
	}

	function toggle(id: string) {
		attached = attached.includes(id) ? attached.filter((entry) => entry !== id) : [...attached, id];
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		busy = true;
		failure = null;
		try {
			const body = {
				name: name.trim(),
				description: description.trim(),
				instructions,
				knowledgeBaseIds: attached,
				indexPastChats,
				retrievalLimit: Number(retrievalLimit) || 6,
			};
			const saved = editing
				? await api<ProjectView>(`/projects/${editing.id}`, json(body, "PATCH"))
				: await api<ProjectView>("/projects", json(body));
			await load();
			await openDetail(saved.id);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}

	// ---- one project --------------------------------------------------------

	let current = $state<ProjectView | null>(null);
	let conversations = $state<ProjectConversation[]>([]);
	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");

	async function openDetail(id: string) {
		failure = null;
		notice = null;
		view = "detail";
		try {
			const [detail, listed] = await Promise.all([
				api<ProjectView>(`/projects/${id}`),
				api<{ data: ProjectConversation[] }>(`/projects/${id}/conversations`),
			]);
			current = detail;
			conversations = listed.data;
			if (groups.length === 0) {
				try {
					groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
				} catch {
					/* a convenience: the group field falls back to free text */
				}
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not open that project.";
		}
	}

	function backToList() {
		// Nothing to go back to when the dialog is about one project: closing is
		// what "back" means there, and the tree is the list.
		if (single) {
			onclose();
			return;
		}
		view = "list";
		current = null;
		editing = null;
		conversations = [];
		failure = null;
		notice = null;
	}

	const attachedNames = $derived(
		(current?.knowledgeBaseIds ?? [])
			.map((id) => stores.find((store) => store.id === id)?.name)
			// Named rather than dropped: a project quietly retrieving from fewer
			// bases than its settings list is what nobody debugs.
			.map((base) => base ?? "one you can no longer read")
	);

	/**
	 * Start a chat in this project. The one action that closes the dialog,
	 * because it is the thing the dialog exists to get somebody to.
	 */
	async function newChat() {
		if (!current) return;
		busy = true;
		failure = null;
		try {
			if (!startModel) throw new Error("This deployment has no models available to you.");
			const response = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: startModel, projectId: current.id }),
			});
			if (!response.ok) {
				const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(parsed?.message ?? `Could not start a chat (${response.status}).`);
			}
			const { conversationId } = (await response.json()) as { conversationId: string };
			onclose();
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start a chat.";
		} finally {
			busy = false;
		}
	}

	async function share(event: SubmitEvent) {
		event.preventDefault();
		if (!current || !shareWith.trim()) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			current = await api<ProjectView>(
				`/projects/${current.id}/shares`,
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
		if (!current) return;
		busy = true;
		try {
			current = await api<ProjectView>(
				`/projects/${current.id}/shares?kind=${kind}&principal=${encodeURIComponent(principal)}`,
				{ method: "DELETE" }
			);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not remove that.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!current) return;
		if (
			!confirm(
				`Delete the project “${current.name}”?\n\nIts conversations and knowledge bases are kept — the chats go back to your ordinary list.`
			)
		)
			return;
		busy = true;
		try {
			await api(`/projects/${current.id}`, { method: "DELETE" });
			await load();
			backToList();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not delete it.";
			busy = false;
		}
	}
</script>

<Modal
	width={view === "list" ? s.OVERLAY_WIDE : s.OVERLAY_NARROW}
	{onclose}
	closeButton
	labelledBy="projects-modal-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="projects-modal-title" class={s.TITLE}>
				{#if view === "list"}
					Projects
				{:else if view === "form"}
					{editing ? `Edit ${editing.name}` : "New project"}
				{:else}
					{current?.name ?? "Project"}
				{/if}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					Conversations that share standing instructions and knowledge.
				{:else if view === "form"}
					Everything that makes it a project is on this one screen.
				{:else}
					{current?.description || "What it knows, what has been said, and who else can see it."}
				{/if}
			</p>
		</div>

		{#if failure}
			<p class="{s.ERROR} mb-4">{failure}</p>
		{/if}

		{#if view === "list"}
			<div class="{s.STRIP} {projects.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
				<div class="flex items-center gap-3">
					<div class={s.STRIP_TILE} class:grayscale={projects.length === 0}>
						<LucideFolderOpen class="size-5 text-blue-600 dark:text-blue-500" />
					</div>
					<div>
						<p class={s.STRIP_HEADLINE}>
							{projects.length}
							{projects.length === 1 ? "project" : "projects"}
						</p>
						<p class={s.STRIP_DETAIL}>
							{projects.reduce((total, project) => total + project.conversationCount, 0)}
							conversation{projects.reduce((t, p) => t + p.conversationCount, 0) === 1 ? "" : "s"}
							in them
						</p>
					</div>
				</div>
				<div class="flex gap-2">
					<button onclick={() => openForm(null)} class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						New project
					</button>
				</div>
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
						<button onclick={() => openForm(null)} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							Create Your First Project
						</button>
					</div>
				{:else}
					<div>
						<h3 class={s.SECTION_TITLE}>Yours and shared with you ({projects.length})</h3>
						<div class={s.GRID}>
							{#each projects as project (project.id)}
								<button
									type="button"
									onclick={() => openDetail(project.id)}
									class="{s.card(project.conversationCount > 0)} text-left"
								>
									<div class={s.CARD_BODY}>
										<div class="mb-3 min-w-0">
											<div class="mb-0.5 flex items-center gap-2">
												<LucideFolderOpen class="size-4 flex-shrink-0 text-gray-400" />
												<h3 class={s.CARD_TITLE}>{project.name}</h3>
											</div>
											<p class={s.CARD_SUBTITLE}>
												{project.description || "No description"}
											</p>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											<span class="{s.PILL} {s.PILL_TONES.busy}">
												<IconChat class="size-3" />
												{project.conversationCount}
											</span>
											{#if project.knowledgeBaseIds.length > 0}
												<span class="text-xs text-gray-600 dark:text-gray-400">
													{project.knowledgeBaseIds.length} base{project.knowledgeBaseIds.length ===
													1
														? ""
														: "s"}
												</span>
											{/if}
											{#if project.indexPastChats}
												<span class="{s.PILL} {s.PILL_TONES.good}">past chats</span>
											{/if}
											{#if !project.owned}
												<span class="{s.PILL} {s.PILL_TONES.neutral}">shared with you</span>
											{/if}
										</div>
									</div>
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>• Every chat started in a project carries its instructions and its documents.</li>
						<li>• A shared project is a shared workspace — everyone sees every conversation.</li>
						<li>• Sharing a project does <strong>not</strong> share its knowledge bases.</li>
						<li>• Deleting a project keeps its chats; they return to your ordinary list.</li>
					</ul>
				</div>
			</div>
		{:else if view === "form"}
			<form class="flex flex-col gap-4" onsubmit={save}>
				<div>
					<label for="project-name" class={s.LABEL}>Name</label>
					<input
						id="project-name"
						class={s.INPUT}
						placeholder="Grant application"
						maxlength="128"
						bind:value={name}
						required
						disabled={busy}
					/>
				</div>
				<div>
					<label for="project-description" class={s.LABEL}>
						What it is for <span class="font-normal text-gray-500">(optional)</span>
					</label>
					<input
						id="project-description"
						class={s.INPUT}
						maxlength="500"
						bind:value={description}
						disabled={busy}
					/>
				</div>
				<div>
					<label for="project-instructions" class={s.LABEL}>Standing instructions</label>
					<textarea
						id="project-instructions"
						class="{s.INPUT} min-h-28"
						placeholder="We are writing a Horizon Europe proposal. Answer in British English and cite the call text where it applies."
						bind:value={instructions}
						disabled={busy}
					></textarea>
					<p class={s.HINT}>
						Added to the system prompt of every conversation here. Text only — a project with tools
						and a fixed model is what an agent is.
					</p>
				</div>

				<div>
					<span class={s.LABEL}>
						Knowledge bases <span class="font-normal text-gray-500">(optional)</span>
					</span>
					{#if stores.length === 0}
						<p class={s.HINT}>You have none yet. Create one under Knowledge.</p>
					{:else}
						<div class="max-h-40 space-y-1 overflow-y-auto">
							{#each stores as store (store.id)}
								<label class="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										checked={attached.includes(store.id)}
										onchange={() => toggle(store.id)}
										disabled={busy}
										class="mt-0.5 accent-blue-600"
									/>
									<span>
										{store.name}
										<span class="text-xs text-gray-500">
											· {store.file_counts.completed} indexed{#if !store.owned}, shared with you{/if}
										</span>
									</span>
								</label>
							{/each}
						</div>
					{/if}
					<p class={s.HINT}>
						Sharing this project does <strong>not</strong> share these.
					</p>
				</div>

				<label class="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={indexPastChats}
						disabled={busy}
						class="mt-0.5 accent-blue-600"
					/>
					<span>
						Search this project's own past conversations
						<span class="block text-xs text-gray-500 dark:text-gray-400">
							Finished exchanges go into a knowledge base of their own — it appears under Knowledge,
							and you can empty or delete it like any other. Off by default, because it copies what
							was said into a searchable store.
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
						disabled={busy}
					/>
				</div>

				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (editing ? openDetail(editing.id) : backToList())}
						disabled={busy}
						class={s.SECONDARY}
					>
						Cancel
					</button>
					<button type="submit" disabled={busy || !name.trim()} class={s.PRIMARY}>
						{busy ? "Saving…" : editing ? "Save" : "Create"}
					</button>
				</div>
			</form>
		{:else if current}
			<div class={s.STACK}>
				<div class="{s.STRIP} {s.STRIP_ACTIVE}">
					<div class="flex items-center gap-3">
						<div class={s.STRIP_TILE}>
							<LucideFolderOpen class="size-5 text-blue-600 dark:text-blue-500" />
						</div>
						<div>
							<p class={s.STRIP_HEADLINE}>
								{current.conversationCount} conversation{current.conversationCount === 1 ? "" : "s"}
							</p>
							<p class={s.STRIP_DETAIL}>
								{attachedNames.length} knowledge base{attachedNames.length === 1 ? "" : "s"}
								{#if current.indexPastChats}· past chats searchable{/if}
								{#if !current.owned}· shared with you{/if}
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						{#if !single}
							<button onclick={backToList} class={s.SECONDARY}>
								<IconArrowLeft class="size-4" />
								All projects
							</button>
						{/if}
						<button onclick={() => openForm(current)} class={s.SECONDARY}>
							<IconSettings class="size-4" />
							{current.owned ? "Edit" : "View settings"}
						</button>
						<button onclick={newChat} disabled={busy} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							New chat
						</button>
					</div>
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Standing instructions</h3>
					{#if current.instructions.trim()}
						<p class="text-sm whitespace-pre-wrap text-gray-700 dark:text-gray-300">
							{current.instructions}
						</p>
					{:else}
						<p class={s.SUBTITLE}>None — chats here behave normally until you add some.</p>
					{/if}
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Knowledge</h3>
					{#if attachedNames.length === 0}
						<p class={s.SUBTITLE}>No knowledge bases attached.</p>
					{:else}
						<p class="text-sm text-gray-700 dark:text-gray-300">{attachedNames.join(", ")}</p>
					{/if}
				</div>

				<div>
					<h3 class={s.SECTION_TITLE}>Conversations ({conversations.length})</h3>
					{#if conversations.length === 0}
						<div class={s.EMPTY}>
							<IconChat class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>Nothing here yet</p>
							<p class={s.EMPTY_DETAIL}>Start one and it will carry this project's instructions</p>
							<button onclick={newChat} disabled={busy} class={s.PRIMARY}>
								<IconAddLarge class="size-4" />
								Start the First Chat
							</button>
						</div>
					{:else}
						<ul class="space-y-2">
							{#each conversations as conversation (conversation.id)}
								<li class={s.card(false)}>
									<a
										href="{base}/conversation/{conversation.id}"
										onclick={onclose}
										class="flex items-center justify-between gap-3 px-4 py-2.5 no-underline"
									>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium">{conversation.title}</span>
											<span class="text-xs text-gray-600 dark:text-gray-400">
												{conversation.model}
												{#if !conversation.mine}· somebody else's{/if}
											</span>
										</span>
										<IconChat class="size-4 flex-shrink-0 text-gray-400" />
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if current.owned}
					<div>
						<h3 class={s.SECTION_TITLE}>Share it</h3>
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

						{#if current.shares.length > 0}
							<ul class="mt-3 space-y-1">
								{#each current.shares as entry (entry.kind + entry.principal)}
									<li class="flex items-center justify-between gap-2 text-sm">
										<span>
											{entry.principal}
											<span class="text-xs text-gray-500">· {entry.kind}</span>
										</span>
										<button
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
							did not start. And an address is not checked: a typo and a colleague who has not signed
							in yet look the same until they open it.
						</p>
						<div class="mt-3 flex justify-end">
							<button onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
								<IconTrash class="size-3" />
								Delete this project
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</Modal>
