<!--
	One knowledge base: its documents, and who can see it.

	Two things here are worth knowing before changing them.

	**Indexing is asynchronous and the status is the progress bar.** Uploading
	returns `in_progress` by design — extraction and embedding happen off the
	request (ADR 0062) — so this page polls while anything is in flight and
	stops when nothing is. A page that showed the POST response and never
	refreshed would show "in progress" forever.

	**Sharing takes an address, not an id.** Nobody knows a colleague's uuid,
	and there is no endpoint a chat session can reach that turns one into the
	other, so the gateway's share endpoint resolves an email server-side. It
	will say plainly when nobody here uses that address, which is the honest
	failure: accepting the share and storing a grant against nothing would let
	somebody believe they had shared.
-->
<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import FileDrop from "$lib/components/FileDrop.svelte";
	import { goto } from "$app/navigation";
	import {
		GatewayError,
		gwDelete,
		gwGet,
		gwPost,
		gwUpload,
		type BillableGroup,
		type KnowledgeDocument,
		type KnowledgeStatus,
		type Share,
		type VectorStore,
	} from "$lib/gateway";

	const id = $derived(page.params.id as string);

	let store = $state<VectorStore | null>(null);
	let documents = $state<KnowledgeDocument[]>([]);
	let shares = $state<Share[]>([]);
	let groups = $state<BillableGroup[]>([]);
	let status = $state<KnowledgeStatus | null>(null);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	let text = $state("");
	// A batch, not one file: dropping a folder's worth at once is the common
	// case, and uploading them one at a time was the thing that made this
	// cumbersome.
	let pending = $state<File[]>([]);
	let uploadProgress = $state<string | null>(null);
	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");
	let shareRole = $state<"viewer" | "editor">("viewer");

	const canEdit = $derived(store !== null && (store.owned || store.role === "editor"));
	const indexing = $derived(documents.some((d) => d.status === "in_progress"));

	async function load(quiet = false) {
		if (!quiet) failure = null;
		try {
			const [detail, docs] = await Promise.all([
				gwGet<VectorStore>(`vector_stores/${id}`),
				gwGet<{ data: KnowledgeDocument[] }>(`vector_stores/${id}/files`),
			]);
			store = detail;
			documents = docs.data;
			if (detail.owned) {
				// Only the owner may read the recipient list: being given a
				// document does not imply learning who else has it.
				const listed = await gwGet<{ data: Share[] }>(`vector_stores/${id}/shares`);
				shares = listed.data;
			}
		} catch (err) {
			if (!quiet) {
				failure = err instanceof GatewayError ? err.message : "Could not load this base.";
			}
		}
	}

	onMount(async () => {
		await load();
		try {
			status = await gwGet<KnowledgeStatus>("vector_stores/status");
			groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
		} catch {
			/* both are conveniences: the page works without them */
		}
		// Polls only while something is indexing, and quietly — a transient
		// failure mid-poll should not replace the page with an error.
		poll = setInterval(() => {
			if (indexing) void load(true);
		}, 2000);
	});

	onDestroy(() => {
		if (poll) clearInterval(poll);
	});

	async function addText(event: SubmitEvent) {
		event.preventDefault();
		if (!text.trim()) return;
		busy = true;
		failure = null;
		try {
			await gwPost(`vector_stores/${id}/text`, {
				text: text.trim(),
				// The first line. A note still needs *a* title to be findable in
				// a list and nameable in a citation, but asking for one was
				// busywork on the way to the thing somebody wanted.
				title: text.trim().split("\n")[0].slice(0, 80),
			});
			text = "";
			await load();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not add that.";
		} finally {
			busy = false;
		}
	}

	async function uploadPending() {
		if (pending.length === 0) return;
		busy = true;
		failure = null;
		const failed: string[] = [];
		let done = 0;
		for (const file of pending) {
			uploadProgress = `Uploading ${++done} of ${pending.length}: ${file.name}`;
			try {
				// Two steps, and they are two steps in the gateway too: a file is
				// owned by one person and may be indexed into more than one base,
				// so uploading and attaching are separate acts. No title —
				// the gateway falls back to the filename, which is the name
				// somebody recognises in a citation.
				const stored = await gwUpload<{ id: string }>("files", file);
				await gwPost(`vector_stores/${id}/files`, { file_id: stored.id });
			} catch (err) {
				// Collected rather than thrown: one bad file in a batch of ten
				// should not discard the nine that worked.
				failed.push(
					`${file.name} — ${err instanceof GatewayError ? err.message : "upload failed"}`
				);
			}
		}
		uploadProgress = null;
		pending = [];
		busy = false;
		failure = failed.length > 0 ? failed.join("; ") : null;
		await load();
	}

	async function removeDocument(document: KnowledgeDocument) {
		busy = true;
		failure = null;
		try {
			await gwDelete(`vector_stores/${id}/files/${document.id}`);
			await load();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not remove it.";
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
			await gwPost(`vector_stores/${id}/shares`, {
				principal_kind: shareKind,
				...(shareKind === "user"
					? { principal_email: shareWith.trim() }
					: { group_name: shareWith.trim() }),
				role: shareRole,
			});
			shareWith = "";
			notice = "Shared.";
			await load();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not share it.";
		} finally {
			busy = false;
		}
	}

	async function unshare(entry: Share) {
		busy = true;
		failure = null;
		try {
			await gwDelete(`vector_stores/${id}/shares/${entry.principal_kind}/${entry.principal_id}`);
			await load();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not remove the share.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!confirm(`Delete "${store?.name}" and everything indexed in it?`)) return;
		busy = true;
		try {
			await gwDelete(`vector_stores/${id}`);
			await goto(`${base}/knowledge`);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not delete it.";
			busy = false;
		}
	}

	function groupNameFor(entry: Share): string {
		return groups.find((g) => g.id === entry.principal_id)?.name ?? entry.principal_id;
	}
</script>

<svelte:head><title>{store?.name ?? "Knowledge base"}</title></svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
	<a href="{base}/knowledge" class="text-sm text-gray-500 no-underline hover:underline">
		← All knowledge bases
	</a>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if store}
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex flex-col gap-1">
				<h1 class="text-xl font-semibold">{store.name}</h1>
				{#if store.description}
					<p class="text-sm text-gray-500 dark:text-gray-400">{store.description}</p>
				{/if}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{#if store.embedding_model}
						Indexed with {store.embedding_model}
						{#if store.dimensions}· {store.dimensions} dimensions{/if}
					{:else}
						Nothing indexed yet.
					{/if}
					{#if !store.owned}· shared with you as {store.role}{/if}
				</p>
			</div>
			{#if store.owned}
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

		{#if canEdit}
			<section
				class="flex flex-col gap-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
			>
				<h2 class="text-sm font-medium">Add to this base</h2>

				<div class="flex flex-col gap-2">
					<FileDrop bind:files={pending} maxBytes={status?.max_upload_bytes} disabled={busy} />
					{#if uploadProgress}
						<p class="text-xs text-gray-600 dark:text-gray-300">{uploadProgress}</p>
					{/if}
					{#if pending.length > 0}
						<div class="flex justify-end">
							<button
								type="button"
								onclick={uploadPending}
								disabled={busy}
								class="rounded-full bg-black px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
							>
								Add {pending.length} file{pending.length === 1 ? "" : "s"}
							</button>
						</div>
					{/if}
				</div>

				<form class="flex flex-col gap-2" onsubmit={addText}>
					<textarea
						class="min-h-24 rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						placeholder="Or paste a note — its first line becomes the title"
						bind:value={text}
					></textarea>
					<div class="flex justify-end">
						<button
							type="submit"
							disabled={busy || !text.trim()}
							class="rounded-full border border-gray-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-gray-600"
						>
							Add note
						</button>
					</div>
				</form>
			</section>
		{/if}

		<section class="flex flex-col gap-2">
			<h2 class="text-sm font-medium">
				Documents
				{#if indexing}
					<span class="ml-1 text-xs font-normal text-gray-500">indexing…</span>
				{/if}
			</h2>
			{#if documents.length === 0}
				<p class="text-sm text-gray-500">Nothing in here yet.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each documents as document (document.id)}
						<li
							class="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
						>
							<div class="flex min-w-0 flex-col gap-0.5">
								<span class="truncate text-sm">{document.title || document.filename}</span>
								<span class="text-xs text-gray-500 dark:text-gray-400">
									{document.status === "completed"
										? `${document.chunk_count} passage${document.chunk_count === 1 ? "" : "s"}`
										: document.status === "failed"
											? "failed"
											: "indexing…"}
									{#if document.chars > 0}· {document.chars} characters{/if}
									{#if document.pages > 0}· {document.pages} pages{/if}
								</span>
								{#if document.last_error}
									<!-- The gateway's own words. "This document has no text
									     layer — use an OCR model" tells somebody what to do
									     next; "failed" does not. -->
									<span class="text-xs text-red-700 dark:text-red-300">{document.last_error}</span>
								{/if}
							</div>
							{#if canEdit}
								<button
									type="button"
									onclick={() => removeDocument(document)}
									disabled={busy}
									class="shrink-0 rounded-full border border-gray-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-gray-600"
								>
									Remove
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if store.owned}
			<section
				class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
			>
				<h2 class="text-sm font-medium">Who can see this</h2>

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
					<label class="flex flex-col gap-1">
						<span class="text-xs text-gray-500 dark:text-gray-400">Can</span>
						<select
							class="rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-900"
							bind:value={shareRole}
						>
							<option value="viewer">Read and search</option>
							<option value="editor">Also add documents</option>
						</select>
					</label>
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
					Neither role can delete this base or re-share it — that stays with you.
				</p>

				{#if shares.length === 0}
					<p class="text-sm text-gray-500">Only you.</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each shares as entry (entry.principal_kind + entry.principal_id)}
							<li class="flex items-center justify-between gap-2 text-sm">
								<span>
									{entry.principal_kind === "user"
										? (entry.email ?? "a deleted account")
										: `${groupNameFor(entry)} (group)`}
									<span class="text-xs text-gray-500"> · {entry.role}</span>
								</span>
								<button
									type="button"
									onclick={() => unshare(entry)}
									disabled={busy}
									class="rounded-full border border-gray-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-gray-600"
								>
									Remove
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{:else if !failure}
		<p class="text-sm text-gray-500">Loading…</p>
	{/if}
</div>
