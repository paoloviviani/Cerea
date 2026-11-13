<!--
	The notes an agent keeps, as a side-pane view of the session screen: one list for this
	session, one for the whole workspace (every session in that folder). The owner can add,
	edit and delete any of them.

	The agent writes these itself, so they may include anything it read while working, and
	say so on screen: they are notes, never instructions. The chat never reads them.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import {
		addAgentNote,
		deleteAgentNote,
		editAgentNote,
		listAgentNotes,
		type AgentNoteKey,
	} from "$lib/agentNotesApi";
	import { AGENT_MEMORY_TEXT_MAX_CHARS, type AgentMemoryView } from "$lib/types/ScopedMemory";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrash from "~icons/carbon/trash-can";

	interface Props {
		deviceId: string;
		sessionId: string;
		workspaceId?: string;
		/** Called with the total number of notes in both lists after each load. */
		oncount?: (count: number) => void;
	}
	let { deviceId, sessionId, workspaceId, oncount }: Props = $props();

	type Scope = "session" | "workspace";
	const scopes = $derived<{ scope: Scope; key: string }[]>([
		{ scope: "session", key: sessionId },
		...(workspaceId ? [{ scope: "workspace" as const, key: workspaceId }] : []),
	]);

	let notes = $state<Record<Scope, AgentMemoryView[]>>({ session: [], workspace: [] });
	let loaded = $state(false);
	let failure = $state<string | null>(null);
	let drafts = $state<Record<Scope, string>>({ session: "", workspace: "" });
	let editing = $state<{ scope: Scope; id: string; text: string } | null>(null);
	let busy = $state(false);

	const keyOf = (scope: Scope): AgentNoteKey => ({
		deviceId,
		scope,
		key: scope === "session" ? sessionId : (workspaceId ?? ""),
	});

	async function load() {
		try {
			const next: Record<Scope, AgentMemoryView[]> = { session: [], workspace: [] };
			for (const { scope } of scopes) next[scope] = await listAgentNotes(keyOf(scope));
			notes = next;
			failure = null;
			oncount?.(next.session.length + next.workspace.length);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.notes.failed"]();
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		void deviceId;
		void sessionId;
		void workspaceId;
		loaded = false;
		void load();
	});

	async function run(action: () => Promise<void>) {
		busy = true;
		failure = null;
		try {
			await action();
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.notes.failed"]();
		} finally {
			busy = false;
		}
	}

	function add(scope: Scope) {
		const text = drafts[scope].trim();
		if (!text) return;
		void run(async () => {
			await addAgentNote(keyOf(scope), text);
			drafts[scope] = "";
		});
	}
	const remove = (scope: Scope, id: string) =>
		void run(async () => deleteAgentNote(keyOf(scope), id));
	function save() {
		const current = editing;
		if (!current || !current.text.trim()) return;
		void run(async () => {
			await editAgentNote(keyOf(current.scope), current.id, current.text.trim());
			editing = null;
		});
	}
</script>

<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="agent-notes">
	<p class="mb-4 text-xs text-ink-muted">{m["code.notes.hint"]()}</p>

	{#each scopes as { scope } (scope)}
		<section class="mb-6" data-testid="agent-notes-{scope}">
			<h3 class="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
				{scope === "session"
					? m["code.notes.session_title"]({ count: notes.session.length })
					: m["code.notes.workspace_title"]({ count: notes.workspace.length })}
			</h3>
			<p class="mb-2 text-xs text-ink-faint">
				{scope === "session" ? m["code.notes.session_hint"]() : m["code.notes.workspace_hint"]()}
			</p>
			{#if loaded && notes[scope].length === 0 && !failure}
				<p class="mb-2 text-xs text-ink-faint">{m["code.notes.empty"]()}</p>
			{/if}
			<ul class="mb-2 space-y-2">
				{#each notes[scope] as note (note.id)}
					<li class="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
						{#if editing?.id === note.id}
							<textarea
								class="w-full resize-y rounded-md border border-line bg-surface p-1.5 text-xs text-ink"
								rows="3"
								maxlength={AGENT_MEMORY_TEXT_MAX_CHARS}
								aria-label={m["code.notes.edit_label"]()}
								bind:value={editing.text}
							></textarea>
							<div class="mt-1 flex gap-2">
								<button
									type="button"
									class="rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-subtle"
									disabled={busy || !editing.text.trim()}
									onclick={save}>{m["code.notes.save"]()}</button
								>
								<button
									type="button"
									class="rounded-md px-1.5 py-0.5 text-ink-muted hover:bg-sunken"
									onclick={() => (editing = null)}>{m["code.notes.cancel"]()}</button
								>
							</div>
						{:else}
							<div class="flex items-start gap-2">
								<span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-ink"
									>{note.text}</span
								>
								<button
									type="button"
									class="shrink-0 rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
									aria-label={m["code.notes.edit"]()}
									title={m["code.notes.edit"]()}
									onclick={() => (editing = { scope, id: note.id, text: note.text })}
									><CarbonEdit class="size-3.5" /></button
								>
								<button
									type="button"
									class="shrink-0 rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
									aria-label={m["code.notes.delete"]()}
									title={m["code.notes.delete"]()}
									disabled={busy}
									onclick={() => remove(scope, note.id)}><CarbonTrash class="size-3.5" /></button
								>
							</div>
							<p class="mt-0.5 text-xxs text-ink-faint">
								{note.source === "user" ? m["code.notes.by_you"]() : m["code.notes.by_agent"]()}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="flex gap-2">
				<input
					type="text"
					class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
					placeholder={m["code.notes.placeholder"]()}
					aria-label={m["code.notes.new_label"]()}
					maxlength={AGENT_MEMORY_TEXT_MAX_CHARS}
					bind:value={drafts[scope]}
					onkeydown={(e) => {
						if (e.key === "Enter") add(scope);
					}}
				/>
				<button
					type="button"
					class="shrink-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-accent-subtle disabled:opacity-50"
					disabled={busy || !drafts[scope].trim()}
					onclick={() => add(scope)}>{m["code.notes.add"]()}</button
				>
			</div>
		</section>
	{/each}

	{#if failure}
		<p class="text-xs text-red-600 dark:text-red-400" role="alert">{failure}</p>
	{/if}
</div>
