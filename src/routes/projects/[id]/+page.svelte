<!--
	One project: what it knows, what has been said in it, and who else can see it.

	Three things this page has to say out loud, because all three are deliberate
	and all three surprise people (ADR 0062).

	**A shared project is a shared workspace.** Everyone who can see it sees
	every conversation in it, including ones other people started. That is the
	difference between sharing a project and sharing a chat.

	**Sharing a project does not share its knowledge bases.** Retrieval
	re-checks the reader's own access to every attached base on every turn, so a
	colleague sees passages only from bases they could already read.

	**A share names an address, not a person.** Nothing resolves it: a typo and
	a colleague who has not signed in yet look identical until somebody with
	that address opens the project.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import CarbonAdd from "~icons/carbon/add";
	import ProjectModal from "$lib/components/ProjectModal.svelte";
	import { GatewayError, gwGet, type BillableGroup, type VectorStore } from "$lib/gateway";
	import { useSettingsStore } from "$lib/stores/settings";
	import type { ProjectView } from "$lib/types/Project";

	interface ProjectConversation {
		id: string;
		title: string;
		model: string;
		updatedAt: string;
		mine: boolean;
	}

	const id = $derived(page.params.id as string);
	const settings = useSettingsStore();

	// The same choice the home page makes: the person's active model if it is
	// still one of the deployment's, the first otherwise. Duplicated as a
	// two-line derived rather than lifted into a helper — the home page's
	// version also has the ML Assistant rules, which have no meaning here.
	const models = $derived((page.data.models ?? []) as { id: string }[]);
	const startModel = $derived(
		models.some((model) => model.id === $settings.activeModel)
			? $settings.activeModel
			: models[0]?.id
	);

	let project = $state<ProjectView | null>(null);
	let conversations = $state<ProjectConversation[]>([]);
	let stores = $state<VectorStore[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let showEdit = $state(false);

	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");

	// The two fields this passes, rather than `RequestInit` — the DOM lib type is
	// not in scope for the Svelte eslint config, and naming what is used is
	// clearer than borrowing an interface with forty members.
	interface Call {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	}

	async function api<T>(path: string, init?: Call): Promise<T> {
		const response = await fetch(`${base}/api/v2${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	async function load() {
		failure = null;
		try {
			const [detail, listed] = await Promise.all([
				api<ProjectView>(`/projects/${id}`),
				api<{ data: ProjectConversation[] }>(`/projects/${id}/conversations`),
			]);
			project = detail;
			conversations = listed.data;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load this project.";
		}
	}

	onMount(async () => {
		await load();
		try {
			stores = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
			groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
			/* the dialog falls back to no checklist, the share field to free text */
		}
	});

	const attachedNames = $derived(
		(project?.knowledgeBaseIds ?? [])
			.map((baseId) => stores.find((store) => store.id === baseId)?.name)
			// A base attached but no longer readable by this person is named as
			// such rather than vanishing: a project quietly retrieving from
			// fewer bases than its settings list is what nobody debugs.
			.map((name) => name ?? "one you can no longer read")
	);

	/**
	 * Start a chat inside this project. The conversation is created empty and
	 * the composer on the conversation page takes the first message — the
	 * project's own page is not a second composer to keep in step with the one
	 * that already exists.
	 */
	async function newChat() {
		if (!project) return;
		busy = true;
		failure = null;
		try {
			if (!startModel) {
				throw new Error("This deployment has no models available to you.");
			}
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
			await goto(`${base}/conversation/${conversationId}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start a chat.";
		} finally {
			busy = false;
		}
	}

	async function share(event: SubmitEvent) {
		event.preventDefault();
		if (!shareWith.trim()) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			project = await api<ProjectView>(`/projects/${id}/shares`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					shareKind === "user"
						? { kind: "user", email: shareWith.trim() }
						: { kind: "group", name: shareWith.trim() }
				),
			});
			shareWith = "";
			notice =
				"Added. They will see this project — and every conversation in it — the next time " +
				"they open Projects.";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not share it.";
		} finally {
			busy = false;
		}
	}

	async function unshare(kind: "user" | "group", principal: string) {
		busy = true;
		try {
			project = await api<ProjectView>(
				`/projects/${id}/shares?kind=${kind}&principal=${encodeURIComponent(principal)}`,
				{ method: "DELETE" }
			);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not remove that.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (
			!confirm(
				`Delete the project "${project?.name}"?\n\nIts conversations and knowledge bases are ` +
					"kept — the chats go back to your ordinary list."
			)
		)
			return;
		busy = true;
		try {
			await api(`/projects/${id}`, { method: "DELETE" });
			await goto(`${base}/projects`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not delete it.";
			busy = false;
		}
	}
</script>

<svelte:head><title>{project?.name ?? "Project"}</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<a href="{base}/projects" class="text-sm text-gray-500 no-underline hover:underline">
		← All projects
	</a>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if project}
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex flex-col gap-1">
				<h1 class="text-xl font-semibold">{project.name}</h1>
				{#if project.description}
					<p class="text-sm text-gray-500 dark:text-gray-400">{project.description}</p>
				{/if}
				{#if !project.owned}
					<p class="text-xs text-gray-500 dark:text-gray-400">
						Shared with you. You can chat in it; its settings belong to whoever created it.
					</p>
				{/if}
			</div>
			<div class="flex shrink-0 gap-2">
				<button
					type="button"
					onclick={newChat}
					disabled={busy}
					class="flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
				>
					<CarbonAdd /> New chat
				</button>
				<button
					type="button"
					onclick={() => (showEdit = true)}
					class="rounded-full border border-gray-300 px-3 py-1 text-xs dark:border-gray-600"
				>
					{project.owned ? "Edit" : "View settings"}
				</button>
				{#if project.owned}
					<button
						type="button"
						onclick={destroy}
						disabled={busy}
						class="rounded-full border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300"
					>
						Delete
					</button>
				{/if}
			</div>
		</header>

		<section class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-500 dark:text-gray-400">
					Standing instructions
				</span>
				{#if project.instructions.trim()}
					<p class="text-sm whitespace-pre-wrap">{project.instructions}</p>
				{:else}
					<p class="text-sm text-gray-500">None — chats here behave normally until you add some.</p>
				{/if}
			</div>
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-500 dark:text-gray-400">Knowledge</span>
				{#if attachedNames.length === 0}
					<p class="text-sm text-gray-500">No knowledge bases attached.</p>
				{:else}
					<p class="text-sm">{attachedNames.join(", ")}</p>
				{/if}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{#if project.indexPastChats}
						This project's own past conversations are searchable too. Up to
					{:else}
						Up to
					{/if}
					{project.retrievalLimit} passage{project.retrievalLimit === 1 ? "" : "s"} per answer.
				</p>
			</div>
		</section>

		<section class="flex flex-col gap-2">
			<h2 class="text-sm font-medium">
				Conversations
				<span class="text-gray-500">({project.conversationCount})</span>
			</h2>
			{#if conversations.length === 0}
				<p class="text-sm text-gray-500">
					Nothing here yet. Start one and it will carry this project's instructions.
				</p>
			{:else}
				<ul class="flex flex-col gap-1">
					{#each conversations as conversation (conversation.id)}
						<li>
							<a
								href="{base}/conversation/{conversation.id}"
								class="flex flex-wrap items-baseline gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm no-underline hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
							>
								<span class="font-medium">{conversation.title}</span>
								<span class="text-xs text-gray-500 dark:text-gray-400">
									{conversation.model}
									{#if !conversation.mine}· somebody else's{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if project.owned}
			<section
				class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
			>
				<h2 class="text-sm font-medium">Share this project</h2>
				<form class="flex flex-wrap items-end gap-2" onsubmit={share}>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-gray-500 dark:text-gray-400">With</span>
						<select
							class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
							bind:value={shareKind}
						>
							<option value="user">A person</option>
							<option value="group">A group</option>
						</select>
					</label>
					{#if shareKind === "group" && groups.length > 0}
						<label class="flex flex-1 flex-col gap-1">
							<span class="text-xs text-gray-500 dark:text-gray-400">Group</span>
							<select
								class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
								bind:value={shareWith}
							>
								<option value="">— choose —</option>
								{#each groups as group (group.id)}
									<option value={group.name}>{group.name}</option>
								{/each}
							</select>
						</label>
					{:else}
						<label class="flex flex-1 flex-col gap-1">
							<span class="text-xs text-gray-500 dark:text-gray-400">
								{shareKind === "user" ? "Their email address" : "Group name"}
							</span>
							<input
								class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
								placeholder={shareKind === "user" ? "colleague@example.org" : "research"}
								bind:value={shareWith}
							/>
						</label>
					{/if}
					<button
						type="submit"
						disabled={busy || !shareWith.trim()}
						class="rounded-full bg-black px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
					>
						Share
					</button>
				</form>

				{#if project.shares.length > 0}
					<ul class="flex flex-col gap-1">
						{#each project.shares as entry (entry.kind + entry.principal)}
							<li class="flex items-center justify-between gap-2 text-sm">
								<span>
									{entry.principal}
									<span class="text-xs text-gray-500">· {entry.kind}</span>
								</span>
								<button
									type="button"
									onclick={() => unshare(entry.kind, entry.principal)}
									disabled={busy}
									class="text-xs text-red-700 underline disabled:opacity-50 dark:text-red-300"
								>
									Remove
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				{#if notice}
					<p class="text-xs text-gray-600 dark:text-gray-300">{notice}</p>
				{/if}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Everyone here sees <strong>every conversation</strong> in the project, including ones you
					did not start. Sharing it does <strong>not</strong> share its knowledge bases — they see passages
					only from bases they can already read. And an address is not checked: a typo and a colleague
					who has not signed in yet look the same until they open it.
				</p>
			</section>
		{/if}
	{:else if !failure}
		<p class="text-sm text-gray-500">Loading…</p>
	{/if}
</div>

{#if showEdit && project}
	<ProjectModal
		{stores}
		{project}
		onsaved={(saved) => (project = saved)}
		onclose={() => (showEdit = false)}
	/>
{/if}
