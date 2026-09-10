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
	import {
		GatewayError,
		gwDelete,
		gwGet,
		gwPost,
		type Agent,
		type BillableGroup,
		type VectorStore,
	} from "$lib/gateway";

	const id = $derived(page.params.id as string);

	let agent = $state<Agent | null>(null);
	let stores = $state<VectorStore[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	let description = $state("");
	let systemPrompt = $state("");
	let attached = $state<string[]>([]);
	let retrievalLimit = $state("6");
	let temperature = $state("");

	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");

	const canEdit = $derived(agent !== null && (agent.owned || agent.role === "editor"));

	function seed(next: Agent) {
		agent = next;
		description = next.description;
		systemPrompt = next.system_prompt;
		attached = [...next.knowledge_base_ids];
		retrievalLimit = String(next.retrieval_limit);
		const t = next.generation?.temperature;
		temperature = typeof t === "number" ? String(t) : "";
	}

	async function load() {
		failure = null;
		try {
			const [detail, bases] = await Promise.all([
				gwGet<Agent>(`agents/${id}`),
				// The bases *this* person can reach. Offering any others would
				// produce an agent the gateway refuses to save.
				gwGet<{ data: VectorStore[] }>("vector_stores"),
			]);
			seed(detail);
			stores = bases.data;
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

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = null;
		notice = null;
		try {
			const body: Record<string, unknown> = {
				description: description.trim(),
				system_prompt: systemPrompt,
				knowledge_base_ids: attached,
				retrieval_limit: Number(retrievalLimit) || 6,
			};
			// An empty temperature means "say nothing", not "zero": the agent
			// supplies defaults only where the request is silent, and writing 0
			// would pin every conversation to it.
			body.generation = temperature.trim() === "" ? {} : { temperature: Number(temperature) };
			seed(await gwPost<Agent>(`agents/${id}`, body));
			notice = "Saved.";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not save it.";
		} finally {
			busy = false;
		}
	}

	function toggleBase(baseId: string) {
		attached = attached.includes(baseId)
			? attached.filter((entry) => entry !== baseId)
			: [...attached, baseId];
	}

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
		</header>

		<form
			class="flex flex-col gap-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
			onsubmit={save}
		>
			<input
				class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
				placeholder="What it is for"
				maxlength="500"
				bind:value={description}
				disabled={!canEdit}
			/>

			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">Instructions</span>
				<textarea
					class="min-h-32 rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					placeholder="You answer only from the passages provided, and you name the source."
					bind:value={systemPrompt}
					disabled={!canEdit}
				></textarea>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Sent ahead of every conversation. Somebody's own system message is kept and comes
					after this, so they can still say what their task is.
				</span>
			</label>

			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Knowledge bases</span>
				{#if stores.length === 0}
					<p class="text-xs text-gray-500 dark:text-gray-400">
						You have no knowledge bases yet. <a href="{base}/knowledge">Create one</a> and it
						will appear here.
					</p>
				{:else}
					{#each stores as store (store.id)}
						<label class="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								checked={attached.includes(store.id)}
								onchange={() => toggleBase(store.id)}
								disabled={!canEdit}
								class="mt-0.5"
							/>
							<span>
								{store.name}
								<span class="text-xs text-gray-500">
									· {store.file_counts.completed} indexed
									{#if !store.owned}· shared with you{/if}
								</span>
							</span>
						</label>
					{/each}
				{/if}
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Sharing this agent does <strong>not</strong> share these. Whoever uses it sees
					passages only from bases they can already read.
				</span>
			</div>

			<div class="flex flex-wrap gap-4">
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500 dark:text-gray-400">Passages per answer</span>
					<input
						type="number"
						min="1"
						max="50"
						class="w-28 rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={retrievalLimit}
						disabled={!canEdit}
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs text-gray-500 dark:text-gray-400">
						Temperature — blank to leave it to the caller
					</span>
					<input
						type="number"
						step="0.1"
						min="0"
						max="2"
						class="w-28 rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						bind:value={temperature}
						disabled={!canEdit}
					/>
				</label>
			</div>

			{#if notice}
				<p class="text-xs text-gray-600 dark:text-gray-300">{notice}</p>
			{/if}

			{#if canEdit}
				<div class="flex justify-end">
					<button
						type="submit"
						disabled={busy}
						class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			{/if}
		</form>

		{#if agent.owned}
			<section class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
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
				<p class="text-xs text-gray-500 dark:text-gray-400">
					If they cannot use <code>{agent.model}</code>, the agent will not appear in their
					model list and calling it by name tells them why. The share is still allowed.
				</p>
			</section>
		{/if}
	{:else if !failure}
		<p class="text-sm text-gray-500">Loading…</p>
	{/if}
</div>
