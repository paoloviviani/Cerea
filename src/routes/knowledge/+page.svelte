<!--
	Knowledge bases, for the people who use them rather than the person who
	administers the pipeline (ADR 0062).

	Creating one is a *user* action, deliberately: a knowledge base is somebody's
	set of documents, owned by them, shared by them. The administrator's screen
	decides how documents are read and embedded; it does not decide whose they
	are.

	The create form used to be inline, and creating then landed you on an empty
	detail page to add documents one at a time. It is now a single dialog that
	takes the name and the files together, because nobody wants an empty
	knowledge base — what they have is a name and a pile of files.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import CarbonAdd from "~icons/carbon/add";
	import KnowledgeBaseModal from "$lib/components/KnowledgeBaseModal.svelte";
	import {
		GatewayError,
		gwGet,
		type KnowledgeStatus,
		type VectorStore,
	} from "$lib/gateway";

	let stores = $state<VectorStore[]>([]);
	let status = $state<KnowledgeStatus | null>(null);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let showCreate = $state(false);

	async function load() {
		failure = null;
		try {
			// Both, in parallel: the list is what to show and the status is
			// whether indexing can honestly be promised.
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

	function created(store: VectorStore) {
		// Prepended, then reloaded: the row appears at once, and the reload
		// picks up the document counts the uploads produced — which the create
		// response predates.
		stores = [store, ...stores.filter((entry) => entry.id !== store.id)];
		void load();
	}
</script>

<svelte:head><title>Knowledge bases</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h1 class="text-xl font-semibold">Knowledge bases</h1>
			<p class="text-sm text-gray-500 dark:text-gray-400">
				Documents an assistant can search. Yours to own and to share; how they are read and
				embedded is a deployment setting.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (showCreate = true)}
			class="flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
		>
			<CarbonAdd /> New
		</button>
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
			create a base and add files; they will index once an administrator chooses one.
		</p>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if stores.length === 0}
		<p class="text-sm text-gray-500">
			No knowledge bases yet. <button
				type="button"
				onclick={() => (showCreate = true)}
				class="underline">Create one</button
			> and drop some files into it.
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

{#if showCreate}
	<KnowledgeBaseModal
		maxUploadBytes={status?.max_upload_bytes}
		oncreated={created}
		onclose={() => (showCreate = false)}
	/>
{/if}
