<!--
	A memory write, shown where it happened.

	This card is the reason `remember` and `forget` are not behind the
	approval gate (ADR 0075). Asking permission before each write would be the
	most frequent interruption in the product and would teach people to
	dismiss approval cards unread; showing the write afterwards, undoably,
	costs nothing when the model gets it right and is one click when it does
	not.

	So the undo is the load-bearing part, and it deliberately calls the same
	two routes the Memory screen uses rather than a special reversal endpoint:
	undoing a `remembered` deletes that row, undoing a `forgot` re-creates the
	fact from the text the update carried. That is also why the text is
	carried in full — after a `forgot` there is no row left to read it from.

	Drawn in the transcript's own idiom (the muted inline row `PlanCard`
	uses), not the workspace card language: this is a line in a conversation,
	not a panel.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import type { MessageMemoryUpdate } from "$lib/types/MessageUpdate";
	import LucideBrain from "~icons/lucide/brain";
	import CarbonUndo from "~icons/carbon/undo";

	interface Props {
		update: MessageMemoryUpdate;
	}

	let { update }: Props = $props();

	// `undone` is intentionally local and not persisted. The update is the
	// historical record of what the model did on that turn, and rewriting it
	// would make the transcript disagree with itself; what the undo changes
	// is the store, which the Memory screen is the view of.
	let undone = $state(false);
	let working = $state(false);
	let failure = $state<string | null>(null);

	const label = $derived(update.action === "remembered" ? "Remembered" : "Forgot");

	async function undo() {
		working = true;
		failure = null;
		try {
			const response =
				update.action === "remembered"
					? await fetch(`${base}/api/v2/memory/${update.memoryId}`, { method: "DELETE" })
					: await fetch(`${base}/api/v2/memory`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ text: update.text }),
						});
			if (!response.ok) {
				const parsed = await response.json().catch(() => null);
				throw new Error(parsed?.message ?? `That did not work (${response.status}).`);
			}
			undone = true;
		} catch (err) {
			failure = err instanceof Error ? err.message : "That did not work.";
		} finally {
			working = false;
		}
	}

	// A `remembered` with no id cannot be deleted, so it offers no undo it
	// could not honour. Nothing emits one today; the guard is here because a
	// button that fails is worse than a button that is absent.
	const canUndo = $derived(update.action === "forgot" || Boolean(update.memoryId));
</script>

<div class="flex max-w-full min-w-0 flex-col items-start gap-0.5">
	<div class="flex max-w-full min-w-0 items-center gap-1.5 text-sm">
		<LucideBrain class="size-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
		<span class="shrink-0 font-medium text-gray-600 dark:text-gray-300">{label}</span>
		<span
			class="min-w-0 truncate text-gray-500 dark:text-gray-400 {undone
				? 'line-through opacity-60'
				: ''}"
			title={update.text}
		>
			{update.text}
		</span>
		{#if undone}
			<span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">· undone</span>
		{:else if canUndo}
			<button
				type="button"
				class="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-px text-xs text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:text-gray-500 dark:hover:text-gray-200"
				onclick={undo}
				disabled={working}
			>
				<CarbonUndo class="size-3" />
				Undo
			</button>
		{/if}
	</div>
	{#if failure}
		<p class="text-xs text-red-600 dark:text-red-400">{failure}</p>
	{/if}
</div>
