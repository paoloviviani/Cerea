<!--
	Knowledge bases, as an overlay in this app's own dialog language.

	Three views in one dialog rather than three pages: the list, the form that
	creates a base already full of documents, and one base's contents. The MCP
	dialog does the same thing with `currentView`, and for the same reason — a
	person managing knowledge is doing one task, and navigating away from the
	chat to do it loses their place in the conversation that prompted it.

	The gateway owns all of this (ADR 0062): files, extraction, embedding, the
	vector store and the sharing. Everything here is a call through
	`/api/v2/gateway`, which attaches the session's token server-side.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import FileDrop from "$lib/components/FileDrop.svelte";
	import {
		GatewayError,
		gwDelete,
		gwGet,
		gwPost,
		gwUpload,
		type BillableGroup,
		type KnowledgeDocument,
		type KnowledgeStatus,
		type VectorStore,
	} from "$lib/gateway";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconRefresh from "~icons/carbon/renew";
	import IconTrash from "~icons/carbon/trash-can";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconPending from "~icons/carbon/pending-filled";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconShare from "~icons/carbon/share";
	import IconDocument from "~icons/carbon/document";
	import LucideLibrary from "~icons/lucide/library";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** Open straight onto one base, for `/knowledge/<id>`. */
		initialId?: string;
		onclose: () => void;
	}

	let { initialId, onclose }: Props = $props();

	type View = "list" | "create" | "detail";
	// Read once: `initialId` is the address somebody arrived on. A `$derived`
	// here would drag them back to the detail view every time they navigated
	// to the list inside the dialog.
	let view = $state<View>(untrack(() => (initialId ? "detail" : "list")));

	let stores = $state<VectorStore[]>([]);
	let status = $state<KnowledgeStatus | null>(null);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	const indexed = $derived(stores.reduce((total, store) => total + store.file_counts.completed, 0));
	const working = $derived(
		stores.reduce((total, store) => total + store.file_counts.in_progress, 0)
	);

	async function load() {
		failure = null;
		try {
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

	// `onMount`, not the component body: these managers are also rendered as
	// pages (`/knowledge`, `/agents`, `/projects`), and a page body runs on the
	// server, where a relative fetch has no origin to resolve against.
	// `initialId` is the address somebody arrived on, not a prop that changes
	// under the dialog.
	onMount(() =>
		load().then(() => {
			if (initialId) void openDetail(initialId);
		})
	);

	function tone(store: VectorStore): { tone: s.PillTone; label: string } {
		if (store.file_counts.failed > 0)
			return { tone: "bad", label: `${store.file_counts.failed} failed` };
		if (store.file_counts.in_progress > 0)
			return { tone: "busy", label: `${store.file_counts.in_progress} indexing` };
		if (store.file_counts.completed > 0)
			return { tone: "good", label: `${store.file_counts.completed} indexed` };
		return { tone: "neutral", label: "empty" };
	}

	// ---- create -------------------------------------------------------------
	//
	// One submit, several requests, and that shows rather than hides: a file
	// cannot attach to a base that does not exist, so the base is made first
	// and every later failure is reported *against* it. Discarding a base
	// holding four of five files would be worse than naming the fifth.

	let name = $state("");
	let description = $state("");
	let pending = $state<File[]>([]);
	let note = $state("");
	let busy = $state(false);
	let progress = $state<string | null>(null);
	let rejected = $state<string[]>([]);

	function resetForm() {
		name = "";
		description = "";
		pending = [];
		note = "";
		rejected = [];
		failure = null;
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		busy = true;
		failure = null;
		rejected = [];

		let store: VectorStore;
		try {
			progress = "Creating…";
			store = await gwPost<VectorStore>("vector_stores", {
				name: name.trim(),
				description: description.trim(),
			});
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not create it.";
			busy = false;
			progress = null;
			return;
		}

		let done = 0;
		for (const file of pending) {
			progress = `Uploading ${++done} of ${pending.length}: ${file.name}`;
			try {
				const stored = await gwUpload<{ id: string }>("files", file);
				// No title: the gateway falls back to the filename, which is the
				// name somebody recognises in a citation.
				await gwPost(`vector_stores/${store.id}/files`, { file_id: stored.id });
			} catch (err) {
				rejected = [
					...rejected,
					`${file.name} — ${err instanceof GatewayError ? err.message : "upload failed"}`,
				];
			}
		}

		if (note.trim()) {
			progress = "Adding the note…";
			try {
				await gwPost(`vector_stores/${store.id}/text`, {
					text: note.trim(),
					// The first line. A note still needs a title to be findable in
					// a list and nameable in a citation; asking for one was
					// busywork on the way to the thing somebody wanted.
					title: note.trim().split("\n")[0].slice(0, 80),
				});
			} catch (err) {
				rejected = [
					...rejected,
					`the note — ${err instanceof GatewayError ? err.message : "could not be added"}`,
				];
			}
		}

		busy = false;
		progress = null;
		await load();
		if (rejected.length === 0) {
			resetForm();
			await openDetail(store.id);
		} else {
			// Held on the form: it is the only place the list of what failed is
			// shown, and closing would take it away.
			failure = "The base was created, but some things did not make it in.";
		}
	}

	// ---- one base -----------------------------------------------------------

	let current = $state<VectorStore | null>(null);
	let documents = $state<KnowledgeDocument[]>([]);

	/**
	 * Whether anything is still being indexed.
	 *
	 * "Not finished and not failed" rather than a list of the in-progress
	 * names, because the gateway has two vocabularies for this — its own
	 * `pending`/`extracting`/`embedding`, and the OpenAI-shaped `in_progress`
	 * it uses on the vector-store surface — and a predicate that enumerated one
	 * of them would quietly stop polling the moment the other arrived.
	 */
	const indexing = $derived(
		working > 0 ||
			documents.some((document) => document.status !== "completed" && document.status !== "failed")
	);

	/**
	 * Refresh the data without disturbing what is on screen.
	 *
	 * Deliberately not `openDetail`, which the Refresh button used to call: that
	 * sets the view and clears `notice` and `failure`, which is right for a
	 * click and wrong on a timer — it would wipe the "Reindexing…" line the
	 * reader is in the middle of reading, every few seconds.
	 */
	async function pollOnce() {
		try {
			const [listed, state] = await Promise.all([
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<KnowledgeStatus>("vector_stores/status"),
			]);
			stores = listed.data;
			status = state;
			if (current) {
				const [base, docs] = await Promise.all([
					gwGet<VectorStore>(`vector_stores/${current.id}`),
					gwGet<{ data: KnowledgeDocument[] }>(`vector_stores/${current.id}/files`),
				]);
				current = base;
				documents = docs.data;
			}
		} catch {
			// Swallowed on purpose. A poll is unasked-for, so a failed one must
			// not put an error in front of somebody who did not press anything;
			// the next tick either recovers or the work finishes and polling
			// stops. A failure the reader *caused* still surfaces, because those
			// paths set `failure` themselves.
		}
	}

	/**
	 * Poll while work is outstanding, and only then.
	 *
	 * Ingestion is asynchronous by design — the gateway answers `in_progress`
	 * and the document's status *is* the progress bar — and there was no
	 * polling, so the only way to see a document finish was to press Refresh.
	 * A progress bar that advances when you ask it to is not a progress bar.
	 *
	 * The interval backs off from two seconds to fifteen. A document that has
	 * been extracting for a minute is not about to finish within the next two,
	 * and a dialog left open on a stuck ingestion should not keep asking at the
	 * same rate forever. It is never cancelled on a timeout, though: closing the
	 * dialog stops it, and that is a bound the reader controls. Giving up while
	 * work is genuinely outstanding would put back the state this replaced —
	 * something in progress, and no way to watch it.
	 */
	$effect(() => {
		if (!indexing) return;
		let delay = 2_000;
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const tick = async () => {
			await pollOnce();
			if (stopped) return;
			delay = Math.min(delay * 1.5, 15_000);
			timer = setTimeout(() => void tick(), delay);
		};
		timer = setTimeout(() => void tick(), delay);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
	let groups = $state<BillableGroup[]>([]);
	let shareWith = $state("");
	let shareKind = $state<"user" | "group">("user");
	let notice = $state<string | null>(null);

	async function openDetail(id: string) {
		failure = null;
		notice = null;
		view = "detail";
		try {
			const [base, docs] = await Promise.all([
				gwGet<VectorStore>(`vector_stores/${id}`),
				gwGet<{ data: KnowledgeDocument[] }>(`vector_stores/${id}/files`),
			]);
			current = base;
			documents = docs.data;
			if (groups.length === 0) {
				try {
					groups = (await gwGet<{ data: BillableGroup[] }>("billing/groups")).data;
				} catch {
					/* a convenience: the group field falls back to free text */
				}
			}
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not open that base.";
		}
	}

	function backToList() {
		view = "list";
		current = null;
		documents = [];
		failure = null;
		notice = null;
		void load();
	}

	const canEdit = $derived(current !== null && (current.owned || current.role === "editor"));

	async function addFiles() {
		if (!current || pending.length === 0) return;
		busy = true;
		failure = null;
		const failed: string[] = [];
		let done = 0;
		for (const file of pending) {
			progress = `Uploading ${++done} of ${pending.length}: ${file.name}`;
			try {
				const stored = await gwUpload<{ id: string }>("files", file);
				await gwPost(`vector_stores/${current.id}/files`, { file_id: stored.id });
			} catch (err) {
				failed.push(
					`${file.name} — ${err instanceof GatewayError ? err.message : "upload failed"}`
				);
			}
		}
		progress = null;
		pending = [];
		busy = false;
		rejected = failed;
		failure = failed.length > 0 ? "Some files did not make it in." : null;
		await openDetail(current.id);
	}

	async function addNote() {
		if (!current || !note.trim()) return;
		busy = true;
		failure = null;
		try {
			await gwPost(`vector_stores/${current.id}/text`, {
				text: note.trim(),
				title: note.trim().split("\n")[0].slice(0, 80),
			});
			note = "";
			await openDetail(current.id);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not add that.";
		} finally {
			busy = false;
		}
	}

	async function removeDocument(id: string) {
		if (!current) return;
		busy = true;
		try {
			await gwDelete(`vector_stores/${current.id}/files/${id}`);
			await openDetail(current.id);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not remove it.";
		} finally {
			busy = false;
		}
	}

	async function reindex() {
		if (!current) return;
		busy = true;
		try {
			await gwPost(`vector_stores/${current.id}/reindex`);
			notice = "Reindexing. It runs in the background; this list follows along.";
			await openDetail(current.id);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not reindex it.";
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
			await gwPost(`vector_stores/${current.id}/shares`, {
				principal_kind: shareKind,
				...(shareKind === "user"
					? { principal_email: shareWith.trim() }
					: { group_name: shareWith.trim() }),
				role: "viewer",
			});
			shareWith = "";
			notice = "Shared. They can read it; only you can change it.";
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not share it.";
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!current) return;
		if (!confirm(`Delete “${current.name}” and everything in it?`)) return;
		busy = true;
		try {
			await gwDelete(`vector_stores/${current.id}`);
			backToList();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : "Could not delete it.";
			busy = false;
		}
	}

	function docTone(document: KnowledgeDocument): { tone: s.PillTone; label: string } {
		switch (document.status) {
			case "completed":
				return { tone: "good", label: `${document.chunk_count} passages` };
			case "failed":
				return { tone: "bad", label: "failed" };
			case "pending":
			case "extracting":
			case "embedding":
				return { tone: "busy", label: document.status };
			default:
				return { tone: "neutral", label: document.status };
		}
	}
</script>

<Modal
	width={view === "list" ? s.OVERLAY_WIDE : s.OVERLAY_NARROW}
	{onclose}
	closeButton
	labelledBy="knowledge-modal-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="knowledge-modal-title" class={s.TITLE}>
				{#if view === "list"}
					Knowledge bases
				{:else if view === "create"}
					New knowledge base
				{:else}
					{current?.name ?? "Knowledge base"}
				{/if}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					Documents an assistant can search. Yours to own and to share.
				{:else if view === "create"}
					Name it and drop the files in — both at once.
				{:else}
					{current?.description || "What is in it, and who can read it."}
				{/if}
			</p>
		</div>

		{#if failure}
			<p class="{s.ERROR} mb-4">{failure}</p>
		{/if}
		{#if rejected.length > 0}
			<ul class="mb-4 {s.TIPS_LIST}">
				{#each rejected as line (line)}
					<li>• {line}</li>
				{/each}
			</ul>
		{/if}

		{#if view === "list"}
			<div class="{s.STRIP} {indexed > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
				<div class="flex items-center gap-3">
					<div class={s.STRIP_TILE} class:grayscale={indexed === 0}>
						<LucideLibrary class="size-5 text-blue-600 dark:text-blue-500" />
					</div>
					<div>
						<p class={s.STRIP_HEADLINE}>
							{stores.length}
							{stores.length === 1 ? "base" : "bases"}
						</p>
						<p class={s.STRIP_DETAIL}>
							{indexed} document{indexed === 1 ? "" : "s"} indexed{working > 0
								? `, ${working} in progress`
								: ""}
						</p>
					</div>
				</div>
				<div class="flex gap-2">
					<button
						onclick={() => {
							resetForm();
							view = "create";
						}}
						class={s.PRIMARY}
					>
						<IconAddLarge class="size-4" />
						New base
					</button>
				</div>
			</div>

			<div class={s.STACK}>
				{#if status && !status.ready}
					<p class={s.NOTICE}>
						{status.detail ??
							"No embedding model is configured, so documents cannot be indexed yet."} You can still create
						a base and add files; they index once an administrator chooses one.
					</p>
				{/if}

				{#if loading}
					<p class={s.SUBTITLE}>Loading…</p>
				{:else if stores.length === 0}
					<div class={s.EMPTY}>
						<LucideLibrary class={s.EMPTY_ICON} />
						<p class={s.EMPTY_TITLE}>No knowledge bases yet</p>
						<p class={s.EMPTY_DETAIL}>
							Drop a pile of documents in one and an assistant can search them
						</p>
						<button
							onclick={() => {
								resetForm();
								view = "create";
							}}
							class={s.PRIMARY}
						>
							<IconAddLarge class="size-4" />
							Create Your First Base
						</button>
					</div>
				{:else}
					<div>
						<h3 class={s.SECTION_TITLE}>Yours and shared with you ({stores.length})</h3>
						<div class={s.GRID}>
							{#each stores as store (store.id)}
								{@const state = tone(store)}
								<button
									type="button"
									onclick={() => openDetail(store.id)}
									class="{s.card(store.file_counts.completed > 0)} text-left"
								>
									<div class={s.CARD_BODY}>
										<div class="mb-3 min-w-0">
											<div class="mb-0.5 flex items-center gap-2">
												<IconDocument class="size-4 flex-shrink-0 text-gray-400" />
												<h3 class={s.CARD_TITLE}>{store.name}</h3>
											</div>
											<p class={s.CARD_SUBTITLE}>
												{store.description || `${store.file_counts.total} documents`}
											</p>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											<span class="{s.PILL} {s.PILL_TONES[state.tone]}">
												{#if state.tone === "good"}
													<IconCheckmark class="size-3" />
												{:else if state.tone === "busy"}
													<IconPending class="size-3" />
												{:else if state.tone === "bad"}
													<IconWarning class="size-3" />
												{:else}
													<IconPending class="size-3" />
												{/if}
												{state.label}
											</span>
											{#if !store.owned}
												<span class="{s.PILL} {s.PILL_TONES.neutral}">
													shared · {store.role}
												</span>
											{/if}
											{#if store.embedding_model}
												<span class="text-xs text-gray-600 dark:text-gray-400">
													{store.embedding_model}
												</span>
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
						<li>• Attach a base to an agent or a project and it is searched every turn.</li>
						<li>• Sharing a base lets somebody read it; only you can change it.</li>
						<li>• A scan with no text layer needs an OCR model, not the built-in extractor.</li>
						<li>• Reindex after an administrator changes the embedding model.</li>
					</ul>
				</div>
			</div>
		{:else if view === "create"}
			<form class="flex flex-col gap-4" onsubmit={create}>
				<div>
					<label for="kb-name" class={s.LABEL}>Name</label>
					<input
						id="kb-name"
						class={s.INPUT}
						placeholder="Team handbook"
						maxlength="128"
						bind:value={name}
						required
						disabled={busy}
					/>
				</div>
				<div>
					<label for="kb-description" class={s.LABEL}>
						What is in it <span class="font-normal text-gray-500">(optional)</span>
					</label>
					<input
						id="kb-description"
						class={s.INPUT}
						maxlength="500"
						bind:value={description}
						disabled={busy}
					/>
				</div>

				<div>
					<span class={s.LABEL}>Documents</span>
					<FileDrop bind:files={pending} maxBytes={status?.max_upload_bytes} disabled={busy} />
					<p class={s.HINT}>
						No titles needed — each file is titled by its filename. Word, Excel, PowerPoint, or a
						PDF with a text layer.
					</p>
				</div>

				<div>
					<label for="kb-note" class={s.LABEL}>
						Or paste a note <span class="font-normal text-gray-500">(optional)</span>
					</label>
					<textarea
						id="kb-note"
						class="{s.INPUT} min-h-24"
						placeholder="Its first line becomes the title."
						bind:value={note}
						disabled={busy}
					></textarea>
				</div>

				{#if progress}
					<p class={s.NOTICE}>{progress}</p>
				{/if}

				<div class="flex justify-end gap-2">
					<button type="button" onclick={backToList} disabled={busy} class={s.SECONDARY}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !name.trim()} class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						{busy ? "Working…" : "Create"}
					</button>
				</div>
			</form>
		{:else if current}
			<div class={s.STACK}>
				<div class="{s.STRIP} {current.file_counts.completed > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
					<div class="flex items-center gap-3">
						<div class={s.STRIP_TILE} class:grayscale={current.file_counts.completed === 0}>
							<LucideLibrary class="size-5 text-blue-600 dark:text-blue-500" />
						</div>
						<div>
							<p class={s.STRIP_HEADLINE}>
								{current.file_counts.total} document{current.file_counts.total === 1 ? "" : "s"}
							</p>
							<p class={s.STRIP_DETAIL}>
								{current.file_counts.completed} indexed
								{#if current.file_counts.in_progress > 0}
									· {current.file_counts.in_progress} in progress
								{/if}
								{#if !current.owned}· shared with you as {current.role}{/if}
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						<button onclick={backToList} class={s.SECONDARY}>
							<IconArrowLeft class="size-4" />
							All bases
						</button>
						{#if canEdit}
							<button onclick={reindex} disabled={busy} class={s.SECONDARY}>
								<IconRefresh class="size-4" />
								Reindex
							</button>
						{/if}
					</div>
				</div>

				{#if notice}
					<p class={s.NOTICE}>{notice}</p>
				{/if}

				{#if canEdit}
					<div>
						<h3 class={s.SECTION_TITLE}>Add to it</h3>
						<FileDrop bind:files={pending} maxBytes={status?.max_upload_bytes} disabled={busy} />
						{#if progress}
							<p class="{s.NOTICE} mt-2">{progress}</p>
						{/if}
						{#if pending.length > 0}
							<div class="mt-2 flex justify-end">
								<button onclick={addFiles} disabled={busy} class={s.PRIMARY}>
									<IconAddLarge class="size-4" />
									Add {pending.length} file{pending.length === 1 ? "" : "s"}
								</button>
							</div>
						{/if}
						<form class="mt-3 flex flex-col gap-2" onsubmit={addNote}>
							<textarea
								class="{s.INPUT} min-h-20"
								placeholder="Or paste a note — its first line becomes the title"
								bind:value={note}
								disabled={busy}
							></textarea>
							<div class="flex justify-end">
								<button type="submit" disabled={busy || !note.trim()} class={s.SECONDARY}>
									Add note
								</button>
							</div>
						</form>
					</div>
				{/if}

				<div>
					<h3 class={s.SECTION_TITLE}>Documents ({documents.length})</h3>
					{#if documents.length === 0}
						<div class={s.EMPTY}>
							<IconDocument class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>Nothing in it yet</p>
							<p class={s.EMPTY_DETAIL}>
								Drop some files above and they will index in the background
							</p>
						</div>
					{:else}
						<ul class="space-y-2">
							{#each documents as document (document.id)}
								{@const state = docTone(document)}
								<li class={s.card(false)}>
									<div class="flex items-center justify-between gap-3 px-4 py-2.5">
										<div class="min-w-0 flex-1">
											<p class={s.CARD_TITLE}>
												{document.title || document.filename || "untitled"}
											</p>
											<div class="mt-1 flex flex-wrap items-center gap-2">
												<span class="{s.PILL} {s.PILL_TONES[state.tone]}">
													{#if state.tone === "good"}
														<IconCheckmark class="size-3" />
													{:else if state.tone === "bad"}
														<IconWarning class="size-3" />
													{:else}
														<IconPending class="size-3" />
													{/if}
													{state.label}
												</span>
												{#if document.last_error}
													<span class="text-xs text-red-600 dark:text-red-400">
														{document.last_error}
													</span>
												{/if}
											</div>
										</div>
										{#if canEdit}
											<button
												onclick={() => removeDocument(document.id)}
												disabled={busy}
												class={s.CARD_DESTRUCTIVE}
											>
												<IconTrash class="size-3" />
												Remove
											</button>
										{/if}
									</div>
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
								<label for="kb-share-kind" class={s.LABEL}>With</label>
								<select id="kb-share-kind" class={s.INPUT} bind:value={shareKind}>
									<option value="user">A person</option>
									<option value="group">A group</option>
								</select>
							</div>
							<div class="min-w-48 flex-1">
								<label for="kb-share-who" class={s.LABEL}>
									{shareKind === "user" ? "Their email address" : "Group name"}
								</label>
								{#if shareKind === "group" && groups.length > 0}
									<select id="kb-share-who" class={s.INPUT} bind:value={shareWith}>
										<option value="">— choose —</option>
										{#each groups as group (group.id)}
											<option value={group.name}>{group.name}</option>
										{/each}
									</select>
								{:else}
									<input
										id="kb-share-who"
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
						<div class="mt-3 flex justify-end">
							<button onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
								<IconTrash class="size-3" />
								Delete this base
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</Modal>
