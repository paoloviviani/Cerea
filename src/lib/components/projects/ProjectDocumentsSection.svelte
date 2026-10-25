<!--
	A project's context documents, as a section of the project page.

	Whole files whose extracted text goes into **every** prompt in the project —
	which is the difference from a knowledge base (searched) and the reason for
	everything this section says out loud: a budget with a bar, a warning that
	large context costs on every message, individual files only (no folders).

	Everyone who can see the project can add and remove, so each row carries
	who added it. One request per file, so each file gets its own outcome and a
	refusal of the third does not discard the first two.

	Loads in `onMount`, like every manager: a page body runs under SSR, where a
	relative fetch has no origin.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import { formatNumber } from "$lib/i18n/format";
	import * as s from "$lib/components/overlay/styles";
	import { KNOWLEDGE_ACCEPT, MAX_ATTACHMENT_BYTES } from "$lib/constants/mime";
	import { PROJECT_DOCUMENTS_MAX_CHARS, PROJECT_DOCUMENTS_WARN_CHARS } from "$lib/types/Memory";
	import type { ProjectDocumentView } from "$lib/types/ProjectDocument";
	import { readDrop } from "$lib/utils/droppedFiles";
	import LucideFileText from "~icons/lucide/file-text";
	import CarbonAdd from "~icons/carbon/add";
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import CarbonWarning from "~icons/carbon/warning-alt";

	interface Props {
		projectId: string;
	}

	let { projectId }: Props = $props();

	let documents = $state<ProjectDocumentView[]>([]);
	let used = $state(0);
	let loading = $state(true);
	let busy = $state(false);
	let dragging = $state(false);
	let failure = $state<string | null>(null);
	/** One line per refused file, kept until the next upload. */
	let refused = $state<string[]>([]);
	let input: HTMLInputElement | undefined = $state();

	const number = (n: number) => formatNumber(n);
	const percent = $derived(Math.min(100, (used / PROJECT_DOCUMENTS_MAX_CHARS) * 100));
	const warn = $derived(used > PROJECT_DOCUMENTS_WARN_CHARS);

	async function api<T>(path: string, init?: { method?: string; body?: FormData }): Promise<T> {
		const response = await fetch(`${base}/api/v2/projects/${projectId}/documents${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["projects.documents.error_status"]({ status: response.status })
			);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	onMount(async () => {
		try {
			const loaded = (
				await api<{ data: { documents: ProjectDocumentView[]; usedChars: number } }>("")
			).data;
			documents = loaded.documents;
			used = loaded.usedChars;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.documents.load_failed"]();
		} finally {
			loading = false;
		}
	});

	async function upload(files: File[]) {
		if (files.length === 0 || busy) return;
		busy = true;
		failure = null;
		refused = [];
		for (const file of files) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				refused = [
					...refused,
					m["projects.documents.too_large"]({
						name: file.name,
						mb: formatNumber(MAX_ATTACHMENT_BYTES / 1024 / 1024),
					}),
				];
				continue;
			}
			try {
				const body = new FormData();
				body.set("file", file);
				const added = (
					await api<{ data: { document: ProjectDocumentView; usedChars: number } }>("", {
						method: "POST",
						body,
					})
				).data;
				documents = [...documents, added.document];
				used = added.usedChars;
			} catch (err) {
				refused = [
					...refused,
					err instanceof Error
						? err.message
						: m["projects.documents.upload_failed"]({ name: file.name }),
				];
			}
		}
		busy = false;
	}

	function picked() {
		const files = [...(input?.files ?? [])];
		if (input) input.value = "";
		void upload(files);
	}

	function dropped(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (!event.dataTransfer) return;
		const { files, folders } = readDrop(event.dataTransfer);
		if (folders > 0) {
			failure = m["projects.documents.folder_refusal"]();
			refused = [];
		}
		void upload(files);
	}

	async function remove(doc: ProjectDocumentView) {
		if (!confirm(m["projects.documents.remove_confirm"]({ name: doc.name }))) return;
		failure = null;
		try {
			await api(`/${doc.id}`, { method: "DELETE" });
			documents = documents.filter((entry) => entry.id !== doc.id);
			used = documents.reduce(
				(sum, entry) => sum + (entry.status === "ready" ? entry.chars : 0),
				0
			);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.documents.remove_failed"]();
		}
	}
</script>

{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}

<div data-testid="project-documents">
	<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
		<h3 class="{s.SECTION_TITLE} mb-0">
			{m["projects.documents.title"]({ count: documents.length })}
		</h3>
		<button type="button" class={s.SECONDARY} disabled={busy} onclick={() => input?.click()}>
			<CarbonAdd class="size-4" />
			{busy ? m["projects.documents.adding"]() : m["projects.documents.add"]()}
		</button>
		<!-- Files only, any number: no `webkitdirectory`, on purpose. -->
		<input
			bind:this={input}
			type="file"
			multiple
			accept={KNOWLEDGE_ACCEPT}
			class="hidden"
			data-testid="project-documents-input"
			onchange={picked}
		/>
	</div>

	<p class="mb-3 text-xs text-ink-muted">
		<Rich
			parts={m["projects.documents.description"].parts({
				mb: formatNumber(MAX_ATTACHMENT_BYTES / 1024 / 1024),
			})}
			tags={{ strong }}
		/>
	</p>

	<div class="mb-3">
		<div class="mb-1 flex justify-between text-xs text-ink-muted">
			<span>
				{m["projects.documents.usage"]({
					used: number(used),
					max: number(PROJECT_DOCUMENTS_MAX_CHARS),
				})}
			</span>
		</div>
		<div
			class="h-2 overflow-hidden rounded-full bg-sunken"
			role="progressbar"
			aria-label={m["projects.documents.usage_label"]()}
			aria-valuemin={0}
			aria-valuemax={PROJECT_DOCUMENTS_MAX_CHARS}
			aria-valuenow={used}
		>
			<div
				class="h-full rounded-full {warn ? 'bg-amber-500' : 'bg-accent-solid'}"
				style="width: {percent}%"
			></div>
		</div>
		{#if warn}
			<p class="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
				<CarbonWarning class="mt-0.5 size-3.5 shrink-0" />
				{m["projects.documents.warn"]()}
			</p>
		{/if}
	</div>

	{#if failure}
		<p class="{s.ERROR} mb-3" role="alert">{failure}</p>
	{/if}
	{#each refused as line (line)}
		<p class="{s.ERROR} mb-2" role="alert">{line}</p>
	{/each}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={dropped}
		class={dragging ? "rounded-lg ring-2 ring-accent" : ""}
		data-testid="project-documents-drop"
	>
		{#if loading}
			<p class={s.SUBTITLE}>{m["projects.documents.loading"]()}</p>
		{:else if documents.length === 0}
			<div class={s.EMPTY}>
				<LucideFileText class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>{m["projects.documents.empty.title"]()}</p>
				<p class={s.EMPTY_DETAIL}>
					{m["projects.documents.empty.detail"]()}
				</p>
				<button type="button" class={s.PRIMARY} disabled={busy} onclick={() => input?.click()}>
					<CarbonAdd class="size-4" />
					{m["projects.documents.add"]()}
				</button>
			</div>
		{:else}
			<ul class="space-y-2">
				{#each documents as doc (doc.id)}
					<li class={s.card(doc.status === "ready")}>
						<div class="flex items-start justify-between gap-3 px-4 py-2.5">
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium" title={doc.name}>{doc.name}</p>
								<p class="text-xs text-ink-muted">
									{#if doc.status === "ready"}
										{m["projects.documents.chars"]({ count: number(doc.chars) })}
									{:else}
										<span class="{s.PILL} {s.PILL_TONES.bad}"
											>{m["projects.documents.unreadable"]()}</span
										>
									{/if}
									· {m["projects.documents.added_by"]({
										who: doc.mine ? m["projects.documents.you"]() : doc.addedBy,
									})}
								</p>
								{#if doc.failure}
									<p class="mt-1 text-xs text-danger">
										{m["projects.documents.failure_note"]({ reason: doc.failure.reason })}
									</p>
								{/if}
							</div>
							<button
								type="button"
								class={s.CARD_DESTRUCTIVE}
								aria-label={m["projects.documents.remove_label"]({ name: doc.name })}
								onclick={() => remove(doc)}
							>
								<CarbonTrashCan class="size-3" />
								{m["projects.documents.remove"]()}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
