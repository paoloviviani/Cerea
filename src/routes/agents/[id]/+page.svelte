<!--
	One agent: its instructions, its knowledge bases, and who can use it.

	Two things about sharing an agent that this page has to say out loud,
	because they are surprising and both are deliberate (ADR 0062).

	**Sharing an agent does not share its knowledge bases.** Retrieval
	re-checks the *recipient's* own access to every attached base on every
	request, so a colleague sees passages only from bases they could already
	read. That is what stops an agent being a way to publish a document without
	sharing the document.

	**An agent may be shared even when its model is not.** The share is allowed;
	the agent simply does not appear in that person's model list, and calling it
	by name answers with the reason. Refusing the share instead would make an
	owner debug somebody else's permissions before they could offer anything.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import AgentModal from "$lib/components/AgentModal.svelte";
	import {
		GatewayError,
		gwDelete,
		gwGet,
		gwPost,
		type Agent,
		type BillableGroup,
		type VectorStore,
	} from "$lib/gateway";

	interface ModelCard {
		id: string;
		display_name?: string | null;
		kind?: string;
	}

	const id = $derived(page.params.id as string);

	let agent = $state<Agent | null>(null);
	let stores = $state<VectorStore[]>([]);
	let models = $state<ModelCard[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let showEdit = $state(false);

	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");

	async function load() {
		failure = null;
		try {
			const [detail, bases, catalogue] = await Promise.all([
				gwGet<Agent>(`agents/${id}`),
				// The bases *this* person can reach. Offering any others would
				// produce an agent the gateway refuses to save.
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<{ data: ModelCard[] }>("models"),
			]);
			agent = detail;
			stores = bases.data;
			models = catalogue.data.filter(
				(entry) => !entry.id.startsWith("agent:") && (entry.kind ?? "chat") === "chat"
			);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not load this agent.";
		}
	}

	onMount(async () => {
		await load();
		try {
			groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
		} catch {
			/* a convenience: the group field falls back to a free-text name */
		}
	});

	const attachedNames = $derived(
		(agent?.knowledge_base_ids ?? [])
			.map((baseId) => stores.find((store) => store.id === baseId)?.name)
			// A base attached but no longer readable by this person shows as
			// such rather than vanishing: an agent quietly retrieving from
			// fewer bases than its configuration lists is what nobody debugs.
			.map((name) => name ?? "one you can no longer read")
	);

	async function share(event: SubmitEvent) {
		event.preventDefault();
		if (!shareWith.trim()) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			await gwPost(`agents/${id}/shares`, {
				principal_kind: shareKind,
				...(shareKind === "user"
					? { principal_email: shareWith.trim() }
					: { group_name: shareWith.trim() }),
				role: "viewer",
			});
			shareWith = "";
			notice = "Shared. They see passages only from knowledge bases they can already read.";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not share it.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!confirm(`Delete the agent "${agent?.name}"?`)) return;
		busy = true;
		try {
			await gwDelete(`agents/${id}`);
			await goto(`${base}/agents`);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not delete it.";
			busy = false;
		}
	}
</script>

<svelte:head><title>{agent?.name ?? "Agent"}</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<a href="{base}/agents" class="text-sm text-gray-500 no-underline hover:underline">
		← All agents
	</a>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if agent}
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex flex-col gap-1">
				<h1 class="text-xl font-semibold">{agent.name}</h1>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Pick <code>{agent.model_name}</code> in the model list to use it · runs on
					{agent.model}
					{#if !agent.owned}· shared with you as {agent.role}{/if}
				</p>
			</div>
			<div class="flex shrink-0 gap-2">
				<button
					type="button"
					onclick={() => (showEdit = true)}
					class="rounded-full border border-gray-300 px-3 py-1 text-xs dark:border-gray-600"
				>
					{agent.owned || agent.role === "editor" ? "Edit" : "View settings"}
				</button>
				{#if agent.owned}
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
			{#if agent.description}
				<p class="text-sm">{agent.description}</p>
			{/if}
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-500 dark:text-gray-400">Instructions</span>
				{#if agent.system_prompt.trim()}
					<p class="text-sm whitespace-pre-wrap">{agent.system_prompt}</p>
				{:else}
					<p class="text-sm text-gray-500">
						None — it behaves as the plain model until you give it some.
					</p>
				{/if}
			</div>
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-500 dark:text-gray-400"> Knowledge bases </span>
				{#if attachedNames.length === 0}
					<p class="text-sm text-gray-500">None attached, so it retrieves nothing.</p>
				{:else}
					<p class="text-sm">{attachedNames.join(", ")}</p>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						Up to {agent.retrieval_limit} passage{agent.retrieval_limit === 1 ? "" : "s"} per answer.
					</p>
				{/if}
			</div>
		</section>

		{#if agent.owned}
			<section
				class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
			>
				<h2 class="text-sm font-medium">Share this agent</h2>
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
				{#if notice}
					<p class="text-xs text-gray-600 dark:text-gray-300">{notice}</p>
				{/if}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Sharing this does <strong>not</strong> share its knowledge bases. And if they cannot use
					<code>{agent.model}</code>, the agent will not appear in their model list and calling it
					by name tells them why — the share is still allowed.
				</p>
			</section>
		{/if}
	{:else if !failure}
		<p class="text-sm text-gray-500">Loading…</p>
	{/if}
</div>

{#if showEdit && agent}
	<AgentModal
		{models}
		{stores}
		{agent}
		onsaved={(saved) => (agent = saved)}
		onclose={() => (showEdit = false)}
	/>
{/if}
