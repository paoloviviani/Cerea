<!--
	A project's shared notes, as a section of the project page.

	Everyone who can see the project can read, add, edit and delete here (see
	`$lib/types/ProjectMemory`), so each note carries its author, the chat it
	came from when the assistant wrote it, and its date: with more than one
	person writing into one list, "who put that there" is the first question.

	Like the personal Memory screen, what is drawn is exactly what the model is
	given. The whole list is injected, and notes past the prompt budget are
	marked as no longer sent using the same arithmetic the server builds the
	block with (`$lib/utils/memoryBudget`) — two copies of it would drift, and a
	screen that disagreed with the prompt would be worse than none.

	Loads in `onMount` for the reason every manager does: this renders under
	SSR as part of a page, where a relative fetch has no origin.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import * as s from "$lib/components/overlay/styles";
	import {
		PROJECT_MEMORY_BLOCK_MAX_CHARS,
		PROJECT_MEMORY_MAX_NOTES,
		PROJECT_MEMORY_TEXT_MAX_CHARS,
	} from "$lib/types/Memory";
	import type { ProjectMemoryView } from "$lib/types/ProjectMemory";
	import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";
	import LucideBrain from "~icons/lucide/brain";
	import CarbonAdd from "~icons/carbon/add";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrashCan from "~icons/carbon/trash-can";

	interface Props {
		projectId: string;
	}

	let { projectId }: Props = $props();

	let notes = $state<ProjectMemoryView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let adding = $state(false);
	let draft = $state("");
	let editingId = $state<string | null>(null);
	let editDraft = $state("");
	let busy = $state(false);

	const budget = $derived(
		fitMemoriesToBudget(
			notes.map((note) => note.text),
			PROJECT_MEMORY_BLOCK_MAX_CHARS
		)
	);
	const omitted = $derived(
		new Set(notes.map((_, index) => index).filter((index) => !budget.included.includes(index)))
	);

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/projects/${projectId}/memory${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : await response.json();
	}

	function body(text: string) {
		return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) };
	}

	onMount(async () => {
		try {
			notes = (await api<{ data: { notes: ProjectMemoryView[] } }>("")).data.notes;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Project memory could not be loaded.";
		} finally {
			loading = false;
		}
	});

	async function add() {
		const text = draft.trim();
		if (!text || busy) return;
		busy = true;
		failure = null;
		try {
			const created = (
				await api<{ data: ProjectMemoryView }>("", { method: "POST", ...body(text) })
			).data;
			// Appended, not reloaded: oldest-first, and this is the newest. A
			// duplicate the server recognised comes back as the existing row.
			notes = notes.some((note) => note.id === created.id) ? notes : [...notes, created];
			draft = "";
			adding = false;
		} catch (err) {
			failure = err instanceof Error ? err.message : "That note could not be saved.";
		} finally {
			busy = false;
		}
	}

	async function saveEdit(id: string) {
		const text = editDraft.trim();
		if (!text || busy) return;
		busy = true;
		failure = null;
		try {
			const updated = (
				await api<{ data: ProjectMemoryView }>(`/${id}`, { method: "PATCH", ...body(text) })
			).data;
			notes = notes.map((note) => (note.id === id ? updated : note));
			editingId = null;
		} catch (err) {
			failure = err instanceof Error ? err.message : "That change could not be saved.";
		} finally {
			busy = false;
		}
	}

	async function remove(note: ProjectMemoryView) {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await api<void>(`/${note.id}`, { method: "DELETE" });
			notes = notes.filter((row) => row.id !== note.id);
		} catch (err) {
			failure = err instanceof Error ? err.message : "That note could not be deleted.";
		} finally {
			busy = false;
		}
	}

	function date(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}
</script>

<div data-testid="project-memory">
	<div class="mb-3 flex items-center justify-between gap-3">
		<h3 class="{s.SECTION_TITLE} mb-0">Project memory ({notes.length})</h3>
		<button
			type="button"
			class={s.SECONDARY}
			disabled={loading || notes.length >= PROJECT_MEMORY_MAX_NOTES}
			onclick={() => {
				adding = true;
				draft = "";
			}}
		>
			<CarbonAdd class="size-4" /> Add note
		</button>
	</div>

	{#if failure}
		<p class="{s.ERROR} mb-3" role="alert">{failure}</p>
	{/if}

	{#if adding}
		<div class="{s.EMBEDDED} mb-3 p-4">
			<label class={s.LABEL} for="project-memory-draft">New note</label>
			<textarea
				id="project-memory-draft"
				class={s.INPUT}
				rows="3"
				bind:value={draft}
				maxlength={PROJECT_MEMORY_TEXT_MAX_CHARS}
				placeholder="Deploys go through the release branch; staging is reset every Monday"
			></textarea>
			<p class={s.HINT}>
				Everyone in this project can read it, and it goes into every chat here. It should make sense
				to a colleague with no context.
			</p>
			<div class="mt-3 flex gap-2">
				<button type="button" class={s.PRIMARY} disabled={!draft.trim() || busy} onclick={add}>
					Save
				</button>
				<button type="button" class={s.SECONDARY} onclick={() => (adding = false)}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if loading}
		<p class={s.SUBTITLE}>Loading…</p>
	{:else if notes.length === 0}
		<div class={s.EMPTY}>
			<LucideBrain class={s.EMPTY_ICON} />
			<p class={s.EMPTY_TITLE}>No project notes yet</p>
			<p class={s.EMPTY_DETAIL}>
				Add one here, or ask the assistant in a chat to remember something for the project.
			</p>
		</div>
	{:else}
		{#if budget.omitted > 0}
			<p class="{s.NOTICE} mb-3">
				{budget.included.length} notes are in use; the {budget.omitted} oldest are too long to fit and
				are no longer sent to the model.
			</p>
		{/if}
		<ul class="space-y-2">
			{#each notes as note, index (note.id)}
				<li class={s.card(false)}>
					<div class={s.CARD_BODY}>
						{#if editingId === note.id}
							<textarea
								class={s.INPUT}
								rows="3"
								aria-label="Edit note"
								bind:value={editDraft}
								maxlength={PROJECT_MEMORY_TEXT_MAX_CHARS}
							></textarea>
							<div class="mt-3 flex gap-2">
								<button
									type="button"
									class={s.PRIMARY}
									disabled={!editDraft.trim() || busy}
									onclick={() => saveEdit(note.id)}
								>
									Save
								</button>
								<button type="button" class={s.SECONDARY} onclick={() => (editingId = null)}>
									Cancel
								</button>
							</div>
						{:else}
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<p
										class="text-sm whitespace-pre-wrap text-ink {omitted.has(index)
											? 'opacity-60'
											: ''}"
									>
										{note.text}
									</p>
									<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
										<span
											class="{s.PILL} {note.source === 'user'
												? s.PILL_TONES.neutral
												: s.PILL_TONES.busy}"
										>
											{note.source === "user" ? "Added by" : "Remembered in a chat of"}
											{note.mine ? "you" : note.author}
										</span>
										<span>{date(note.createdAt)}</span>
										{#if note.conversationId}
											<a class="underline" href="{base}/conversation/{note.conversationId}">
												Source chat
											</a>
										{/if}
										{#if omitted.has(index)}
											<span class="{s.PILL} {s.PILL_TONES.bad}">No longer sent</span>
										{/if}
									</div>
								</div>
								<div class="flex shrink-0 gap-2">
									<button
										type="button"
										class={s.CARD_ACTION}
										onclick={() => {
											editingId = note.id;
											editDraft = note.text;
										}}
									>
										<CarbonEdit class="size-3.5" /> Edit
									</button>
									<button
										type="button"
										class={s.CARD_DESTRUCTIVE}
										disabled={busy}
										onclick={() => remove(note)}
									>
										<CarbonTrashCan class="size-3.5" /> Delete
									</button>
								</div>
							</div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	<p class={s.HINT}>
		Anyone who can see this project can add, edit or delete notes. Never keep a password, key or
		token here: it would ride along in every prompt. Up to {PROJECT_MEMORY_MAX_NOTES} notes; past the
		prompt's budget the oldest stop being sent.
	</p>
</div>
