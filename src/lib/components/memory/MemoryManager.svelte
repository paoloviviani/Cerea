<!--
	The Memory tab of the workspace: what is remembered about you, and whether
	anything is remembered at all.

	**The switch lives here, not on the settings page.** Every other user
	preference sits under Settings, and this one deliberately does not: the
	question "is memory on" is inseparable from "what does it currently hold",
	and splitting them across two screens means turning it on without seeing
	what that means, or reading the list without knowing it is inert. The
	control belongs next to the thing it governs.

	**What the model sees is what is drawn here.** Because the whole list is
	injected rather than searched (see `$lib/types/Memory`), this screen can
	be exact rather than indicative — including about the budget: facts past
	it are marked as no longer sent, using the *same* arithmetic the server
	builds the block with (`$lib/utils/memoryBudget`). A screen that quietly
	disagreed with the prompt would be worse than one that said nothing.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import * as s from "$lib/components/overlay/styles";
	import { useSettingsStore } from "$lib/stores/settings";
	import Switch from "$lib/components/Switch.svelte";
	import { MEMORY_MAX_FACTS, MEMORY_TEXT_MAX_CHARS, type MemoryView } from "$lib/types/Memory";
	import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";
	import LucideBrain from "~icons/lucide/brain";
	import CarbonAdd from "~icons/carbon/add";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonTrashCan from "~icons/carbon/trash-can";

	const settings = useSettingsStore();

	let memories = $state<MemoryView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let adding = $state(false);
	let draft = $state("");
	/** The row being rewritten, by id; at most one at a time. */
	let editingId = $state<string | null>(null);
	let editDraft = $state("");
	let busy = $state(false);

	// The setting is read from the shared store rather than from the list
	// response, so a change made here is reflected everywhere at once and
	// saves through the one debounced path every other preference uses.
	function getEnabled() {
		return $settings.memoryEnabled === true;
	}
	function setEnabled(value: boolean) {
		settings.update((current) => ({ ...current, memoryEnabled: value }));
	}

	const budget = $derived(fitMemoriesToBudget(memories.map((memory) => memory.text)));
	const omitted = $derived(
		new Set(memories.map((_, index) => index).filter((index) => !budget.included.includes(index)))
	);

	// The init shape is spelled out rather than typed `RequestInit`: the lint
	// config has no DOM globals, and the three fields any call here uses are
	// the same three `SkillsManager` names.
	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/memory${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : await response.json();
	}

	async function load() {
		loading = true;
		failure = null;
		try {
			const body = await api<{ data: { memories: MemoryView[] } }>("");
			memories = body.data.memories;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Memory could not be loaded.";
		} finally {
			loading = false;
		}
	}

	// `onMount`, not the component body: this manager renders under SSR as
	// part of the workspace page, where a relative fetch has no origin to
	// resolve against and answers 502.
	onMount(load);

	async function add() {
		const text = draft.trim();
		if (!text || busy) return;
		busy = true;
		failure = null;
		try {
			const body = await api<{ data: MemoryView }>("", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
			// Appended rather than reloaded: the list is chronological and this
			// is the newest, so the order is already known.
			memories = [...memories, body.data];
			draft = "";
			adding = false;
		} catch (err) {
			failure = err instanceof Error ? err.message : "That memory could not be saved.";
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
			const body = await api<{ data: MemoryView }>(`/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
			memories = memories.map((memory) => (memory.id === id ? body.data : memory));
			editingId = null;
		} catch (err) {
			failure = err instanceof Error ? err.message : "That change could not be saved.";
		} finally {
			busy = false;
		}
	}

	async function remove(memory: MemoryView) {
		if (busy) return;
		// No confirmation dialog: one fact is one sentence, it is visible on
		// screen as it goes, and re-typing it costs seconds. A modal per
		// deletion would make tidying up the list the most tedious screen here.
		busy = true;
		failure = null;
		try {
			await api<void>(`/${memory.id}`, { method: "DELETE" });
			memories = memories.filter((row) => row.id !== memory.id);
		} catch (err) {
			failure = err instanceof Error ? err.message : "That memory could not be deleted.";
		} finally {
			busy = false;
		}
	}

	function beginEdit(memory: MemoryView) {
		editingId = memory.id;
		editDraft = memory.text;
	}
</script>

<div class={s.EMBEDDED}>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 class={s.TITLE}>Memory</h2>
			<p class={s.SUBTITLE}>
				Standing facts the assistant carries into every conversation. You can edit or delete any of
				them, and it can add to them while you talk.
			</p>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
		{/if}

		<div class="{s.STRIP} {getEnabled() && memories.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
			<div class="flex items-center gap-3">
				<div class="{s.STRIP_TILE} {getEnabled() ? '' : 'grayscale'}">
					<LucideBrain class="size-5 text-accent" />
				</div>
				<div>
					<p class={s.STRIP_HEADLINE}>
						{memories.length}
						{memories.length === 1 ? "memory" : "memories"}
					</p>
					<p class={s.STRIP_DETAIL}>
						{#if !getEnabled()}
							Off — nothing is being remembered or used
						{:else if budget.omitted > 0}
							{budget.included.length} in use, {budget.omitted} too old to fit
						{:else if memories.length === 0}
							On — nothing remembered yet
						{:else}
							All of them are in use
						{/if}
					</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<Switch name="memoryEnabled" bind:checked={getEnabled, setEnabled} />
				<button
					type="button"
					class={s.PRIMARY}
					disabled={memories.length >= MEMORY_MAX_FACTS}
					onclick={() => {
						adding = true;
						draft = "";
					}}
				>
					<CarbonAdd class="size-4" /> Add memory
				</button>
			</div>
		</div>

		{#if !getEnabled()}
			<!--
				Said plainly, because the alternative is somebody editing a list
				that has no effect. Nothing is deleted by turning it off: that
				would make "let me try this off for a week" irreversible.
			-->
			<div class="{s.NOTICE} mb-4">
				Memory is off. Nothing here is sent to the model and nothing new will be remembered.
				Anything already stored is kept, and is listed below.
			</div>
		{/if}

		{#if adding}
			<div class="{s.EMBEDDED} mb-4 p-4">
				<label class={s.LABEL} for="memory-draft">New memory</label>
				<input
					id="memory-draft"
					class={s.INPUT}
					bind:value={draft}
					maxlength={MEMORY_TEXT_MAX_CHARS}
					placeholder="Prefers concise answers with no preamble"
					onkeydown={(event) => {
						if (event.key === "Enter") add();
						if (event.key === "Escape") adding = false;
					}}
				/>
				<p class={s.HINT}>
					One self-contained sentence. It will be readable with no surrounding context, months from
					now.
				</p>
				<div class="mt-3 flex gap-2">
					<button type="button" class={s.PRIMARY} disabled={!draft.trim() || busy} onclick={add}>
						Save
					</button>
					<button type="button" class={s.SECONDARY} onclick={() => (adding = false)}>
						Cancel
					</button>
				</div>
			</div>
		{/if}

		{#if loading}
			<p class={s.SUBTITLE}>Loading…</p>
		{:else if memories.length === 0}
			<div class={s.EMPTY}>
				<LucideBrain class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>Nothing remembered yet</p>
				<p class={s.EMPTY_DETAIL}>
					Add something here, or just tell the assistant to remember it while you talk.
				</p>
				<button type="button" class={s.PRIMARY} onclick={() => (adding = true)}>
					<CarbonAdd class="size-4" /> Add memory
				</button>
			</div>
		{:else}
			<div class="space-y-2">
				{#each memories as memory, index (memory.id)}
					<div class={s.card(false)}>
						<div class={s.CARD_BODY}>
							{#if editingId === memory.id}
								<input
									class={s.INPUT}
									bind:value={editDraft}
									maxlength={MEMORY_TEXT_MAX_CHARS}
									onkeydown={(event) => {
										if (event.key === "Enter") saveEdit(memory.id);
										if (event.key === "Escape") editingId = null;
									}}
								/>
								<div class="mt-3 flex gap-2">
									<button
										type="button"
										class={s.PRIMARY}
										disabled={!editDraft.trim() || busy}
										onclick={() => saveEdit(memory.id)}
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
										<p class="text-sm text-ink {omitted.has(index) ? 'opacity-60' : ''}">
											{memory.text}
										</p>
										<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
											<span
												class="{s.PILL} {memory.source === 'user'
													? s.PILL_TONES.neutral
													: s.PILL_TONES.busy}"
											>
												{memory.source === "user" ? "You added this" : "Remembered for you"}
											</span>
											{#if omitted.has(index)}
												<!--
													The one thing this screen knows that nothing else
													can tell you: stored, but past the prompt budget
													and therefore no longer reaching the model.
												-->
												<span class="{s.PILL} {s.PILL_TONES.bad}">No longer sent</span>
											{/if}
										</div>
									</div>
									<div class="flex shrink-0 gap-2">
										<button type="button" class={s.CARD_ACTION} onclick={() => beginEdit(memory)}>
											<CarbonEdit class="size-3.5" /> Edit
										</button>
										<button
											type="button"
											class={s.CARD_DESTRUCTIVE}
											disabled={busy}
											onclick={() => remove(memory)}
										>
											<CarbonTrashCan class="size-3.5" /> Delete
										</button>
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="{s.TIPS} mt-6">
			<p class={s.TIPS_TITLE}>Quick tips</p>
			<ul class={s.TIPS_LIST}>
				<li>
					All of these go into every conversation at once — they are not searched, so a fact does
					not have to resemble your question to be used.
				</li>
				<li>
					Say "remember that…" or "forget that…" in a chat and the assistant will edit this list
					itself. You will see the change as it happens, with an undo.
				</li>
				<li>
					Past {MEMORY_MAX_FACTS} facts nothing more is stored, and past the prompt's budget the oldest
					stop being sent — they are marked here when that happens.
				</li>
				<li>Never keep a password, key or token here: it would ride along in every prompt.</li>
			</ul>
		</div>
	</div>
</div>
