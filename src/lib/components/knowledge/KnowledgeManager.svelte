<!--
	Knowledge bases, in this app's own dialog language, as a workspace tab.

	Three views in one screen rather than three pages: the list, the form that
	creates a base already full of documents, and one base's contents. The MCP
	manager does the same thing with `currentView`, and for the same reason — a
	person managing knowledge is doing one task, and switching screens for each
	step of it would lose their place.

	The gateway owns all of this (ADR 0062): files, extraction, embedding, the
	vector store and the sharing. Everything here is a call through
	`/api/v2/gateway`, which attaches the session's token server-side.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { base as appBase } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { formatNumber } from "$lib/i18n/format";
	import FileDrop from "$lib/components/FileDrop.svelte";
	import { KNOWLEDGE_ACCEPT } from "$lib/constants/mime";
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
	import IconView from "~icons/carbon/view";
	import IconDownload from "~icons/carbon/download";
	import LucideLibrary from "~icons/lucide/library";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** Open straight onto one base, for `/knowledge/<id>`. */
		initialId?: string;
	}

	let { initialId }: Props = $props();

	type View = "list" | "create" | "detail";
	// Read once: `initialId` is the address somebody arrived on. A `$derived`
	// here would drag them back to the detail view every time they navigated
	// to the list inside the dialog.
	let view = $state<View>(untrack(() => (initialId ? "detail" : "list")));

	// Everything the person can reach, memory bases included; the screen uses
	// `knowledgeBases` and `memoryBases`, never this directly.
	let allStores = $state<VectorStore[]>([]);
	// A project's past-chat index is not one of the person's knowledge bases:
	// listed apart, read-only, below.
	const stores = $derived(allStores.filter((store) => !store.memory_of));
	const memoryStores = $derived(allStores.filter((store) => store.memory_of));
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
			allStores = listed.data;
			status = state;
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.unreachable"]();
		} finally {
			loading = false;
		}
	}

	// `onMount`, not the component body: these managers are also rendered as
	// pages (`/knowledge`, `/projects`), and a page body runs on the
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
			return {
				tone: "bad",
				label: m["knowledge.manager.tone.failed"]({ count: store.file_counts.failed }),
			};
		if (store.file_counts.in_progress > 0)
			return {
				tone: "busy",
				label: m["knowledge.manager.tone.indexing"]({ count: store.file_counts.in_progress }),
			};
		if (store.file_counts.completed > 0)
			return {
				tone: "good",
				label: m["knowledge.manager.tone.ready"]({ count: store.file_counts.completed }),
			};
		return { tone: "neutral", label: m["knowledge.manager.tone.empty"]() };
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
			progress = m["knowledge.manager.progress.creating"]();
			store = await gwPost<VectorStore>("vector_stores", {
				name: name.trim(),
				description: description.trim(),
			});
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.create_failed"]();
			busy = false;
			progress = null;
			return;
		}

		let done = 0;
		for (const file of pending) {
			progress = m["knowledge.manager.progress.uploading"]({
				index: ++done,
				total: pending.length,
				name: file.name,
			});
			try {
				const stored = await gwUpload<{ id: string }>("files", file);
				// No title: the gateway falls back to the filename, which is the
				// name somebody recognises in a citation.
				await gwPost(`vector_stores/${store.id}/files`, { file_id: stored.id });
			} catch (err) {
				rejected = [
					...rejected,
					m["knowledge.manager.rejected.file"]({
						name: file.name,
						reason:
							err instanceof GatewayError
								? err.message
								: m["knowledge.manager.rejected.upload_failed"](),
					}),
				];
			}
		}

		if (note.trim()) {
			progress = m["knowledge.manager.progress.adding_note"]();
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
					m["knowledge.manager.rejected.note"]({
						reason:
							err instanceof GatewayError
								? err.message
								: m["knowledge.manager.rejected.note_failed"](),
					}),
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
			failure = m["knowledge.manager.created_partial"]();
		}
	}

	// ---- one base -----------------------------------------------------------

	let current = $state<VectorStore | null>(null);
	let documents = $state<KnowledgeDocument[]>([]);

	/**
	 * Whether anything is still being indexed.
	 *
	 * "Not finished and not failed" rather than a list of the in-progress
	 * names, and the finished words are both spellings the pipeline has used:
	 * this app's own rows say `ready`, while the OpenAI-shaped surface this
	 * UI once read said `completed`. A predicate enumerating only one of them
	 * kept polling a finished document forever — which is exactly what
	 * happened, invisibly, until a base held an indexed document.
	 */
	const indexing = $derived(
		working > 0 ||
			documents.some((document) => document.status !== "ready" && document.status !== "failed")
	);

	/**
	 * Refresh the data without disturbing what is on screen.
	 *
	 * Deliberately not `openDetail`, which the Refresh button used to call: that
	 * sets the view and clears `notice` and `failure`, which is right for a
	 * click and wrong on a timer — it would wipe the "Updateing…" line the
	 * reader is in the middle of reading, every few seconds.
	 */
	async function pollOnce() {
		try {
			const [listed, state] = await Promise.all([
				gwGet<{ data: VectorStore[] }>("vector_stores"),
				gwGet<KnowledgeStatus>("vector_stores/status"),
			]);
			allStores = listed.data;
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
		preview = null;
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
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.open_failed"]();
		}
	}

	function backToList() {
		view = "list";
		current = null;
		documents = [];
		failure = null;
		notice = null;
		preview = null;
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
			progress = m["knowledge.manager.progress.uploading"]({
				index: ++done,
				total: pending.length,
				name: file.name,
			});
			try {
				const stored = await gwUpload<{ id: string }>("files", file);
				await gwPost(`vector_stores/${current.id}/files`, { file_id: stored.id });
			} catch (err) {
				failed.push(
					m["knowledge.manager.rejected.file"]({
						name: file.name,
						reason:
							err instanceof GatewayError
								? err.message
								: m["knowledge.manager.rejected.upload_failed"](),
					})
				);
			}
		}
		progress = null;
		pending = [];
		busy = false;
		rejected = failed;
		failure = failed.length > 0 ? m["knowledge.manager.some_failed"]() : null;
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
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.add_failed"]();
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
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.remove_failed"]();
		} finally {
			busy = false;
		}
	}

	// ---- open and download --------------------------------------------------
	//
	// The row's two reads. Preview is the stored extracted markdown — what
	// retrieval actually sees — fetched as JSON and shown below the list.
	// Download is the original bytes, served as an attachment by the route, so
	// it goes through a plain anchor rather than the JSON helpers: the browser
	// carries the session and handles the disposition itself.

	interface DocumentPreview {
		id: string;
		title: string;
		filename: string | null;
		text: string;
		chars: number;
	}

	let preview = $state<DocumentPreview | null>(null);
	let previewBusy = $state(false);

	/**
	 * How much of an extract the panel shows. A base can hold megabytes of
	 * markdown and the panel is a glance, not a reader; the count beside the
	 * title keeps the cut honest, and the download below it has no such cut.
	 */
	const PREVIEW_CHARS = 50_000;

	async function openPreview(id: string) {
		if (!current) return;
		previewBusy = true;
		failure = null;
		try {
			preview = await gwGet<DocumentPreview>(`vector_stores/${current.id}/files/${id}/preview`);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.preview_failed"]();
		} finally {
			previewBusy = false;
		}
	}

	function closePreview() {
		preview = null;
	}

	function downloadDocument(document: KnowledgeDocument) {
		if (!current) return;
		const link = window.document.createElement("a");
		link.href = `${appBase}/api/v2/gateway/vector_stores/${current.id}/files/${document.id}/download`;
		link.download = document.filename || document.title || m["knowledge.manager.document"]();
		link.rel = "noopener";
		window.document.body.appendChild(link);
		link.click();
		link.remove();
	}

	async function reindex() {
		if (!current) return;
		busy = true;
		try {
			await gwPost(`vector_stores/${current.id}/reindex`);
			notice = m["knowledge.manager.updating_notice"]();
			await openDetail(current.id);
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.update_failed"]();
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
			notice = m["knowledge.manager.shared_notice"]();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.share_failed"]();
		} finally {
			busy = false;
		}
	}

	async function destroy() {
		if (!current) return;
		if (!confirm(m["knowledge.manager.delete_confirm"]({ name: current.name }))) return;
		busy = true;
		try {
			await gwDelete(`vector_stores/${current.id}`);
			backToList();
		} catch (err) {
			failure = err instanceof GatewayError ? err.message : m["knowledge.manager.delete_failed"]();
			busy = false;
		}
	}

	const DOC_STATES = {
		pending: m["knowledge.manager.doc.pending"],
		extracting: m["knowledge.manager.doc.extracting"],
		embedding: m["knowledge.manager.doc.embedding"],
	} as const;

	function docTone(document: KnowledgeDocument): { tone: s.PillTone; label: string } {
		// Both finished spellings, for the same reason `indexing` lists both:
		// the rows say `ready`, the surface this replaced said `completed`,
		// and only the failed state is spelled one way.
		switch (document.status) {
			case "ready":
			case "completed":
				return {
					tone: "good",
					label: m["knowledge.manager.doc.passages"]({ count: document.chunk_count }),
				};
			case "failed":
				return { tone: "bad", label: m["knowledge.manager.doc.failed"]() };
			case "pending":
			case "extracting":
			case "embedding":
				return { tone: "busy", label: DOC_STATES[document.status]() };
			default:
				// A status the pipeline added that this screen does not know yet:
				// shown as it came. i18n: server text
				return { tone: "neutral", label: document.status };
		}
	}
</script>

<!-- The workspace tab's card, where the overlay shell used to be. -->
<div class={s.EMBEDDED}>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="knowledge-panel-title" class={s.TITLE}>
				{#if view === "list"}
					{m["knowledge.manager.title"]()}
				{:else if view === "create"}
					{m["knowledge.manager.new_title"]()}
				{:else}
					{current?.name ?? m["knowledge.manager.fallback_title"]()}
				{/if}
			</h2>
			<p class={s.SUBTITLE}>
				{#if view === "list"}
					{m["knowledge.manager.subtitle"]()}
				{:else if view === "create"}
					{m["knowledge.manager.create_subtitle"]()}
				{:else}
					{current?.description || m["knowledge.manager.detail_subtitle"]()}
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
							{m["knowledge.manager.count"]({ count: stores.length })}
						</p>
						<p class={s.STRIP_DETAIL}>
							{working > 0
								? m["knowledge.manager.ready_working"]({ count: indexed, working })
								: m["knowledge.manager.ready"]({ count: indexed })}
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
						{m["knowledge.manager.new"]()}
					</button>
				</div>
			</div>

			<div class={s.STACK}>
				{#if status && !status.ready}
					<p class={s.NOTICE}>
						{m["knowledge.manager.not_ready"]({
							detail: status.detail ?? m["knowledge.manager.not_ready_default"](),
						})}
					</p>
				{/if}

				{#if loading}
					<p class={s.SUBTITLE}>{m["knowledge.manager.loading"]()}</p>
				{:else if stores.length === 0}
					<div class={s.EMPTY}>
						<LucideLibrary class={s.EMPTY_ICON} />
						<p class={s.EMPTY_TITLE}>{m["knowledge.manager.empty.title"]()}</p>
						<p class={s.EMPTY_DETAIL}>{m["knowledge.manager.empty.detail"]()}</p>
						<button
							onclick={() => {
								resetForm();
								view = "create";
							}}
							class={s.PRIMARY}
						>
							<IconAddLarge class="size-4" />
							{m["knowledge.manager.empty.create"]()}
						</button>
					</div>
				{:else}
					<div>
						<h3 class={s.SECTION_TITLE}>
							{m["knowledge.manager.list_heading"]({ count: stores.length })}
						</h3>
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
												{store.description ||
													m["knowledge.manager.card.documents"]({ count: store.file_counts.total })}
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
													{m["knowledge.manager.card.shared"]({ role: store.role })}
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

				{#if !loading && memoryStores.length > 0}
					<details class="text-sm" data-testid="memory-bases">
						<summary class="cursor-pointer text-ink-muted">
							{m["knowledge.manager.memory.title"]({ count: memoryStores.length })}
						</summary>
						<p class="mt-2 text-xs text-ink-muted">{m["knowledge.manager.memory.detail"]()}</p>
						<ul class="mt-2 space-y-1">
							{#each memoryStores as store (store.id)}
								<li class="flex flex-wrap items-center justify-between gap-2">
									<span class="min-w-0 truncate">{store.memory_of?.project_name}</span>
									<a
										href="{appBase}/projects/{store.memory_of?.project_id}"
										class="text-xs text-accent"
									>
										{m["knowledge.manager.memory.open"]()}
									</a>
								</li>
							{/each}
						</ul>
					</details>
				{/if}

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>{m["knowledge.manager.tips.title"]()}</h4>
					<ul class={s.TIPS_LIST}>
						<li>{m["knowledge.manager.tips.project"]()}</li>
						<li>{m["knowledge.manager.tips.sharing"]()}</li>
						<li>{m["knowledge.manager.tips.open"]()}</li>
						<li>{m["knowledge.manager.tips.scan"]()}</li>
						<li>{m["knowledge.manager.tips.update"]()}</li>
					</ul>
				</div>
			</div>
		{:else if view === "create"}
			<form class="flex flex-col gap-4" onsubmit={create}>
				<div>
					<label for="kb-name" class={s.LABEL}>{m["knowledge.manager.form.name"]()}</label>
					<input
						id="kb-name"
						class={s.INPUT}
						placeholder={m["knowledge.manager.form.name_placeholder"]()}
						maxlength="128"
						bind:value={name}
						required
						disabled={busy}
					/>
				</div>
				<div>
					<label for="kb-description" class={s.LABEL}>
						{m["knowledge.manager.form.description"]()}
						<span class="font-normal text-gray-500">{m["knowledge.manager.form.optional"]()}</span>
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
					<span class={s.LABEL}>{m["knowledge.manager.form.documents"]()}</span>
					<FileDrop
						bind:files={pending}
						maxBytes={status?.max_upload_bytes}
						disabled={busy}
						accept={KNOWLEDGE_ACCEPT}
					/>
					<p class={s.HINT}>
						{m["knowledge.manager.form.documents_hint"]()}
					</p>
				</div>

				<div>
					<label for="kb-note" class={s.LABEL}>
						{m["knowledge.manager.form.note"]()}
						<span class="font-normal text-gray-500">{m["knowledge.manager.form.optional"]()}</span>
					</label>
					<textarea
						id="kb-note"
						class="{s.INPUT} min-h-24"
						placeholder={m["knowledge.manager.form.note_placeholder"]()}
						bind:value={note}
						disabled={busy}
					></textarea>
				</div>

				{#if progress}
					<p class={s.NOTICE}>{progress}</p>
				{/if}

				<div class="flex justify-end gap-2">
					<button type="button" onclick={backToList} disabled={busy} class={s.SECONDARY}>
						{m["knowledge.manager.form.cancel"]()}
					</button>
					<button type="submit" disabled={busy || !name.trim()} class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						{busy ? m["knowledge.manager.form.working"]() : m["knowledge.manager.form.create"]()}
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
								{m["knowledge.manager.detail.count"]({ count: current.file_counts.total })}
							</p>
							<p class={s.STRIP_DETAIL}>
								{m["knowledge.manager.detail.ready"]({ count: current.file_counts.completed })}
								{#if current.file_counts.in_progress > 0}
									{m["knowledge.manager.detail.in_progress"]({
										count: current.file_counts.in_progress,
									})}
								{/if}
								{#if !current.owned}{m["knowledge.manager.detail.shared_as"]({
										role: current.role,
									})}{/if}
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						<button onclick={backToList} class={s.SECONDARY}>
							<IconArrowLeft class="size-4" />
							{m["knowledge.manager.detail.all"]()}
						</button>
						{#if canEdit}
							<button onclick={reindex} disabled={busy} class={s.SECONDARY}>
								<IconRefresh class="size-4" />
								{m["knowledge.manager.detail.update"]()}
							</button>
							<!-- Beside Update, where the person looking for it is:
							     the bottom-of-page placement hid it under Share, and
							     a base's owner deletes it once but looks for it more
							     often than that. The confirm says what "everything
							     in it" means, wherever the button sits. -->
							<button onclick={destroy} disabled={busy} class={s.CARD_DESTRUCTIVE}>
								<IconTrash class="size-3" />
								{m["knowledge.manager.detail.delete"]()}
							</button>
						{/if}
					</div>
				</div>

				{#if notice}
					<p class={s.NOTICE}>{notice}</p>
				{/if}

				{#if canEdit}
					<div>
						<h3 class={s.SECTION_TITLE}>{m["knowledge.manager.add.title"]()}</h3>
						<FileDrop
							bind:files={pending}
							maxBytes={status?.max_upload_bytes}
							disabled={busy}
							accept={KNOWLEDGE_ACCEPT}
						/>
						{#if progress}
							<p class="{s.NOTICE} mt-2">{progress}</p>
						{/if}
						{#if pending.length > 0}
							<div class="mt-2 flex justify-end">
								<button onclick={addFiles} disabled={busy} class={s.PRIMARY}>
									<IconAddLarge class="size-4" />
									{m["knowledge.manager.add.files"]({ count: pending.length })}
								</button>
							</div>
						{/if}
						<form class="mt-3 flex flex-col gap-2" onsubmit={addNote}>
							<textarea
								class="{s.INPUT} min-h-20"
								placeholder={m["knowledge.manager.add.note_placeholder"]()}
								bind:value={note}
								disabled={busy}
							></textarea>
							<div class="flex justify-end">
								<button type="submit" disabled={busy || !note.trim()} class={s.SECONDARY}>
									{m["knowledge.manager.add.note"]()}
								</button>
							</div>
						</form>
					</div>
				{/if}

				<div>
					<h3 class={s.SECTION_TITLE}>
						{m["knowledge.manager.docs.title"]({ count: documents.length })}
					</h3>
					{#if documents.length === 0}
						<div class={s.EMPTY}>
							<IconDocument class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>{m["knowledge.manager.docs.empty.title"]()}</p>
							<p class={s.EMPTY_DETAIL}>
								{m["knowledge.manager.docs.empty.detail"]()}
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
												{document.title ||
													document.filename ||
													m["knowledge.manager.docs.untitled"]()}
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
												{#if document.error}
													<span class="text-xs text-red-600 dark:text-red-400">
														{document.error}
													</span>
												{/if}
											</div>
										</div>
										<div class="flex shrink-0 items-center gap-1.5">
											<button
												onclick={() => openPreview(document.id)}
												disabled={previewBusy}
												class={s.CARD_ACTION}
												aria-label={m["knowledge.manager.docs.open_label"]({
													name:
														document.title ||
														document.filename ||
														m["knowledge.manager.document"](),
												})}
											>
												<IconView class="size-3" />
												{m["knowledge.manager.docs.open"]()}
											</button>
											{#if document.file_id}
												<button
													onclick={() => downloadDocument(document)}
													class={s.CARD_ACTION}
													aria-label={m["knowledge.manager.docs.download_label"]({
														name:
															document.title ||
															document.filename ||
															m["knowledge.manager.document"](),
													})}
												>
													<IconDownload class="size-3" />
													{m["knowledge.manager.docs.download"]()}
												</button>
											{/if}
											{#if canEdit}
												<button
													onclick={() => removeDocument(document.id)}
													disabled={busy}
													class={s.CARD_DESTRUCTIVE}
												>
													<IconTrash class="size-3" />
													{m["knowledge.manager.docs.remove"]()}
												</button>
											{/if}
										</div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if preview}
					<div class={s.card(false)}>
						<div class="flex items-center justify-between gap-3 px-4 py-2.5">
							<div class="min-w-0">
								<p class={s.CARD_TITLE}>{preview.title}</p>
								<p class={s.CARD_SUBTITLE}>
									{m["knowledge.manager.preview.subtitle"]({
										name: preview.filename ?? m["knowledge.manager.preview.pasted"](),
										count: formatNumber(preview.chars),
									})}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5">
								<button onclick={closePreview} class={s.CARD_ACTION}>
									{m["knowledge.manager.preview.close"]()}
								</button>
							</div>
						</div>
						<pre
							class="mx-4 mb-4 scrollbar-custom max-h-96 overflow-auto rounded-lg bg-gray-50 p-3 text-xs break-words whitespace-pre-wrap text-gray-800 dark:bg-gray-900 dark:text-gray-200">{preview.text.slice(
								0,
								PREVIEW_CHARS
							)}{preview.text.length > PREVIEW_CHARS
								? `\n\n${m["knowledge.manager.preview.cut"]({
										shown: formatNumber(PREVIEW_CHARS),
										total: formatNumber(preview.chars),
									})}`
								: ""}</pre>
					</div>
				{/if}

				{#if current.owned}
					<div>
						<h3 class={s.SECTION_TITLE}>{m["knowledge.manager.share.title"]()}</h3>
						<form class="flex flex-wrap items-end gap-2" onsubmit={share}>
							<div>
								<label for="kb-share-kind" class={s.LABEL}
									>{m["knowledge.manager.share.with"]()}</label
								>
								<select id="kb-share-kind" class={s.INPUT} bind:value={shareKind}>
									<option value="user">{m["knowledge.manager.share.person"]()}</option>
									<option value="group">{m["knowledge.manager.share.group"]()}</option>
								</select>
							</div>
							<div class="min-w-48 flex-1">
								<label for="kb-share-who" class={s.LABEL}>
									{shareKind === "user"
										? m["knowledge.manager.share.email"]()
										: m["knowledge.manager.share.group_name"]()}
								</label>
								{#if shareKind === "group" && groups.length > 0}
									<select id="kb-share-who" class={s.INPUT} bind:value={shareWith}>
										<option value="">{m["knowledge.manager.share.choose"]()}</option>
										{#each groups as group (group.id)}
											<option value={group.name}>{group.name}</option>
										{/each}
									</select>
								{:else}
									<input
										id="kb-share-who"
										class={s.INPUT}
										placeholder={shareKind === "user"
											? m["knowledge.manager.share.email_placeholder"]()
											: m["knowledge.manager.share.group_placeholder"]()}
										bind:value={shareWith}
									/>
								{/if}
							</div>
							<button type="submit" disabled={busy || !shareWith.trim()} class={s.PRIMARY}>
								<IconShare class="size-4" />
								{m["knowledge.manager.share.button"]()}
							</button>
						</form>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
