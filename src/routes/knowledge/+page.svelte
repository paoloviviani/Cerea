<!--
	Knowledge bases, for the people who use them rather than the person who
	administers the pipeline (ADR 0062).

	Creating one is a *user* action, deliberately: a knowledge base is somebody's
	set of documents, owned by them, shared by them. The administrator's screen
	decides how documents are read and embedded; it does not decide whose they
	are.

	The empty state carries the one thing a new base cannot do anything without
	— an embedding model — because "create" succeeding and "upload" then failing
	is the sequence that wastes somebody's afternoon.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import {
		GatewayError,
		gwGet,
		gwPost,
		type KnowledgeStatus,
		type VectorStore,
	} from "$lib/gateway";

	let stores = $state<VectorStore[]>([]);
	let status = $state<KnowledgeStatus | null>(null);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let creating = $state(false);
	let name = $state("");
	let description = $state("");

	async function load() {
		failure = null;
		try {
			// Both, in parallel: the list is what to show and the status is
			// whether the "new base" form can honestly be offered.
			const [listed, state] = await Promise.all([
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<KnowledgeStatus>("vector_stores/status"),
			]);
			stores = listed.data;
			status = state;
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not reach the gateway.";
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		creating = true;
		failure = null;
		try {
			const made = await gwPost<VectorStore>("vector_stores", {
				name: name.trim(),
				description: description.trim(),
			});
			// Prepended rather than refetched: the list is ordered newest first,
			// so this is what a reload would show anyway.
			stores = [made, ...stores];
			name = "";
			description = "";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not create it.";
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head><title>Knowledge bases</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">Knowledge bases</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">
			Documents an assistant can search. Yours to own and to share; how they are read and
			embedded is a deployment setting.
		</p>
	</header>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if status && !status.ready}
		<p
			class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
		>
			{status.detail ??
				"No embedding model is configured, so documents cannot be indexed yet."} You can still
			create a base; its documents will index once an administrator chooses one.
		</p>
	{/if}

	<form
		class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
		onsubmit={create}
	>
		<h2 class="text-sm font-medium">New knowledge base</h2>
		<input
			class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
			placeholder="Name"
			maxlength="128"
			bind:value={name}
			required
		/>
		<input
			class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
			placeholder="What is in it (optional)"
			maxlength="500"
			bind:value={description}
		/>
		<div class="flex justify-end">
			<button
				type="submit"
				disabled={creating || !name.trim()}
				class="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
			>
				{creating ? "Creating…" : "Create"}
			</button>
		</div>
	</form>

	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if stores.length === 0}
		<p class="text-sm text-gray-500">
			No knowledge bases yet. Create one above, then add documents to it.
		</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each stores as store (store.id)}
				<li>
					<a
						href="{base}/knowledge/{store.id}"
						class="flex flex-col gap-1 rounded-lg border border-gray-200 p-4 no-underline hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{store.name}</span>
							{#if !store.owned}
								<!-- Shared with them, and read-only unless they were made an
								     editor. Saying so here means the detail page's disabled
								     controls are not a surprise. -->
								<span
									class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
									>shared · {store.role}</span
								>
							{/if}
						</div>
						{#if store.description}
							<div class="text-sm text-gray-500 dark:text-gray-400">{store.description}</div>
						{/if}
						<div class="text-xs text-gray-500 dark:text-gray-400">
							{store.file_counts.total} document{store.file_counts.total === 1 ? "" : "s"}
							{#if store.file_counts.in_progress > 0}
								· {store.file_counts.in_progress} indexing
							{/if}
							{#if store.file_counts.failed > 0}
								· <span class="text-red-700 dark:text-red-300"
									>{store.file_counts.failed} failed</span
								>
							{/if}
							{#if store.embedding_model}
								· {store.embedding_model}
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
