<!--
	This chat's notes, as a section of the side panel's Files view.

	They are the notes the assistant keeps for this chat only (it can add them
	itself; each one shows in the transcript with an undo). Here the user can
	read, edit and delete them, add their own, and undo the last change. The
	whole list is sent with every message of this chat, so what is here is
	exactly what the assistant sees.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { base } from "$app/paths";
	import { chatNotes } from "$lib/stores/chatNotes.svelte";
	import { CONVERSATION_MEMORY_TEXT_MAX_CHARS } from "$lib/types/ScopedMemory";
	import CarbonUndo from "~icons/carbon/undo";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrash from "~icons/carbon/trash-can";

	interface Note {
		id: string;
		text: string;
		source: "model" | "user";
	}
	type Last =
		| { kind: "add"; id: string }
		| { kind: "delete"; text: string }
		| { kind: "edit"; id: string; previous: string };

	let { conversationId }: { conversationId: string } = $props();

	let notes = $state<Note[]>([]);
	let loaded = $state(false);
	let failure = $state<string | null>(null);
	let draft = $state("");
	let editingId = $state<string | null>(null);
	let editText = $state("");
	let last = $state<Last | null>(null);
	let busy = $state(false);

	const root = $derived(`${base}/api/v2/conversations/${conversationId}/memory`);

	async function call(url: string, init?: RequestInit) {
		const response = await fetch(url, init);
		if (!response.ok) {
			const parsed = await response.json().catch(() => null);
			throw new Error(parsed?.message ?? m["chat.notes.failed"]());
		}
		return response.status === 204 ? null : ((await response.json()).data ?? null);
	}

	async function load() {
		try {
			const data = await call(root);
			notes = data?.notes ?? [];
			chatNotes.set(notes.length);
			failure = null;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["chat.notes.failed"]();
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		void root;
		last = null;
		loaded = false;
		void load();
	});

	async function run(action: () => Promise<void>) {
		busy = true;
		failure = null;
		try {
			await action();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["chat.notes.failed"]();
		} finally {
			busy = false;
		}
	}

	const post = (text: string) =>
		call(root, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});

	function add() {
		const text = draft.trim();
		if (!text) return;
		void run(async () => {
			const note = await post(text);
			draft = "";
			last = note ? { kind: "add", id: note.id } : null;
			await load();
		});
	}

	function remove(note: Note) {
		void run(async () => {
			await call(`${root}/${note.id}`, { method: "DELETE" });
			last = { kind: "delete", text: note.text };
			await load();
		});
	}

	function startEdit(note: Note) {
		editingId = note.id;
		editText = note.text;
	}

	function saveEdit(note: Note) {
		const text = editText.trim();
		if (!text) return;
		void run(async () => {
			await call(`${root}/${note.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
			last = { kind: "edit", id: note.id, previous: note.text };
			editingId = null;
			await load();
		});
	}

	function undo() {
		const action = last;
		if (!action) return;
		void run(async () => {
			if (action.kind === "add") await call(`${root}/${action.id}`, { method: "DELETE" });
			else if (action.kind === "delete") await post(action.text);
			else
				await call(`${root}/${action.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: action.previous }),
				});
			last = null;
			await load();
		});
	}
</script>

<section data-testid="chat-notes" class="mb-6 border-b border-line pb-4">
	<div class="mb-1 flex items-center gap-2">
		<h3 class="flex-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
			{m["chat.notes.title"]({ count: notes.length })}
		</h3>
		{#if last}
			<button
				type="button"
				class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-muted hover:bg-sunken hover:text-ink disabled:opacity-50"
				onclick={undo}
				disabled={busy}
			>
				<CarbonUndo class="size-3" />
				{m["chat.notes.undo"]()}
			</button>
		{/if}
	</div>
	<p class="mb-3 text-xs text-ink-muted">{m["chat.notes.hint"]()}</p>

	{#if loaded && notes.length === 0 && !failure}
		<p class="mb-3 text-xs text-ink-faint">{m["chat.notes.empty"]()}</p>
	{/if}

	<ul class="mb-3 space-y-2">
		{#each notes as note (note.id)}
			<li class="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
				{#if editingId === note.id}
					<textarea
						class="w-full resize-y rounded-md border border-line bg-surface p-1.5 text-xs text-ink"
						rows="3"
						maxlength={CONVERSATION_MEMORY_TEXT_MAX_CHARS}
						aria-label={m["chat.notes.edit_label"]()}
						bind:value={editText}
					></textarea>
					<div class="mt-1 flex gap-2">
						<button
							type="button"
							class="rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-subtle"
							onclick={() => saveEdit(note)}
							disabled={busy || !editText.trim()}>{m["chat.notes.save"]()}</button
						>
						<button
							type="button"
							class="rounded-md px-1.5 py-0.5 text-ink-muted hover:bg-sunken"
							onclick={() => (editingId = null)}>{m["chat.notes.cancel"]()}</button
						>
					</div>
				{:else}
					<div class="flex items-start gap-2">
						<span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-ink">{note.text}</span>
						<button
							type="button"
							class="shrink-0 rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
							aria-label={m["chat.notes.edit"]()}
							title={m["chat.notes.edit"]()}
							onclick={() => startEdit(note)}><CarbonEdit class="size-3.5" /></button
						>
						<button
							type="button"
							class="shrink-0 rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
							aria-label={m["chat.notes.delete"]()}
							title={m["chat.notes.delete"]()}
							disabled={busy}
							onclick={() => remove(note)}><CarbonTrash class="size-3.5" /></button
						>
					</div>
					<p class="mt-0.5 text-xxs text-ink-faint">
						{note.source === "user" ? m["chat.notes.by_you"]() : m["chat.notes.by_assistant"]()}
					</p>
				{/if}
			</li>
		{/each}
	</ul>

	<div class="flex gap-2">
		<input
			type="text"
			class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
			placeholder={m["chat.notes.placeholder"]()}
			aria-label={m["chat.notes.new_label"]()}
			maxlength={CONVERSATION_MEMORY_TEXT_MAX_CHARS}
			bind:value={draft}
			onkeydown={(e) => {
				if (e.key === "Enter") add();
			}}
		/>
		<button
			type="button"
			class="shrink-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-accent-subtle disabled:opacity-50"
			onclick={add}
			disabled={busy || !draft.trim()}>{m["chat.notes.add"]()}</button
		>
	</div>
	{#if failure}
		<p class="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{failure}</p>
	{/if}
</section>
