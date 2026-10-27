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
	import { m } from "$lib/paraglide/messages";
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
			throw new Error(
				parsed?.message ?? m["memory.manager.error_status"]({ status: response.status })
			);
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
			failure = err instanceof Error ? err.message : m["memory.manager.load_failed"]();
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
			failure = err instanceof Error ? err.message : m["memory.manager.add_failed"]();
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
			failure = err instanceof Error ? err.message : m["memory.manager.edit_failed"]();
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
			failure = err instanceof Error ? err.message : m["memory.manager.delete_failed"]();
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
			<h2 class={s.TITLE}>{m["memory.manager.title"]()}</h2>
			<p class={s.SUBTITLE}>
				{m["memory.manager.subtitle"]()}
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
						{m["memory.manager.count"]({ count: memories.length })}
					</p>
					<p class={s.STRIP_DETAIL}>
						{#if !getEnabled()}
							{m["memory.manager.status.off"]()}
						{:else if budget.omitted > 0}
							{m["memory.manager.status.partial"]({
								used: budget.included.length,
								omitted: budget.omitted,
							})}
						{:else if memories.length === 0}
							{m["memory.manager.status.empty"]()}
						{:else}
							{m["memory.manager.status.all"]()}
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
					<CarbonAdd class="size-4" />
					{m["memory.manager.add"]()}
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
				{m["memory.manager.off_notice"]()}
			</div>
		{/if}

		{#if adding}
			<div class="{s.EMBEDDED} mb-4 p-4">
				<label class={s.LABEL} for="memory-draft">{m["memory.manager.new.label"]()}</label>
				<input
					id="memory-draft"
					class={s.INPUT}
					bind:value={draft}
					maxlength={MEMORY_TEXT_MAX_CHARS}
					placeholder={m["memory.manager.new.placeholder"]()}
					onkeydown={(event) => {
						if (event.key === "Enter") add();
						if (event.key === "Escape") adding = false;
					}}
				/>
				<p class={s.HINT}>{m["memory.manager.new.hint"]()}</p>
				<div class="mt-3 flex gap-2">
					<button type="button" class={s.PRIMARY} disabled={!draft.trim() || busy} onclick={add}>
						{m["memory.manager.save"]()}
					</button>
					<button type="button" class={s.SECONDARY} onclick={() => (adding = false)}>
						{m["memory.manager.cancel"]()}
					</button>
				</div>
			</div>
		{/if}

		{#if loading}
			<p class={s.SUBTITLE}>{m["memory.manager.loading"]()}</p>
		{:else if memories.length === 0}
			<div class={s.EMPTY}>
				<LucideBrain class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>{m["memory.manager.empty.title"]()}</p>
				<p class={s.EMPTY_DETAIL}>
					{m["memory.manager.empty.detail"]()}
				</p>
				<button type="button" class={s.PRIMARY} onclick={() => (adding = true)}>
					<CarbonAdd class="size-4" />
					{m["memory.manager.add"]()}
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
										{m["memory.manager.save"]()}
									</button>
									<button type="button" class={s.SECONDARY} onclick={() => (editingId = null)}>
										{m["memory.manager.cancel"]()}
									</button>
								</div>
							{:else}
								<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
												{memory.source === "user"
													? m["memory.manager.source.user"]()
													: m["memory.manager.source.assistant"]()}
											</span>
											{#if omitted.has(index)}
												<!--
													The one thing this screen knows that nothing else
													can tell you: stored, but past the prompt budget
													and therefore no longer reaching the model.
												-->
												<span class="{s.PILL} {s.PILL_TONES.bad}"
													>{m["memory.manager.unused"]()}</span
												>
											{/if}
										</div>
									</div>
									<div class="flex flex-wrap gap-2 sm:shrink-0">
										<button type="button" class={s.CARD_ACTION} onclick={() => beginEdit(memory)}>
											<CarbonEdit class="size-3.5" />
											{m["memory.manager.edit"]()}
										</button>
										<button
											type="button"
											class={s.CARD_DESTRUCTIVE}
											disabled={busy}
											onclick={() => remove(memory)}
										>
											<CarbonTrashCan class="size-3.5" />
											{m["memory.manager.delete"]()}
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
			<p class={s.TIPS_TITLE}>{m["memory.manager.tips.title"]()}</p>
			<ul class={s.TIPS_LIST}>
				<li>
					{m["memory.manager.tips.all_seen"]()}
				</li>
				<li>
					{m["memory.manager.tips.edit_by_chat"]()}
				</li>
				<li>
					{m["memory.manager.tips.limit"]({ max: MEMORY_MAX_FACTS })}
				</li>
				<li>{m["memory.manager.tips.no_secrets"]()}</li>
			</ul>
		</div>
	</div>
</div>
