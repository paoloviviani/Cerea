<script lang="ts">
	/**
	 * Switch the model this conversation runs on.
	 *
	 * Deliberately **not** the Models dialog. That one is a management surface:
	 * it sets the deployment default, edits per-model system prompts, and opens a
	 * detail view. Reaching it from the composer meant the control that looks
	 * most like a picker — it even draws a caret — was the one thing that could
	 * not pick, and the only way to move a conversation to another model was to
	 * change the default for every future chat as a side effect.
	 *
	 * So this lists, and does one thing when you choose.
	 *
	 * **What "choose" means depends on whether a conversation exists yet**, and
	 * that is not a special case bolted on — it is what the two screens already
	 * mean. In a conversation the model is pinned on the conversation document,
	 * so this PATCHes it. On a new chat there is nothing to pin: the composer
	 * reads `settings.activeModel`, so choosing sets what this chat will start
	 * on. The app already states that rule to the reader — "the default is what a
	 * new chat starts on; an open chat keeps its own" — and this follows it
	 * rather than inventing a third behaviour.
	 *
	 * The PATCH is the one `ModelSwitch.svelte` already makes for the
	 * "this model is no longer available" banner, including the invalidation
	 * afterwards: the conversation document *and* the sidebar both carry the
	 * model, so refreshing one and not the other leaves the list showing the
	 * model the chat has just stopped using.
	 */
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import Modal from "$lib/components/Modal.svelte";
	import * as s from "$lib/components/overlay/styles";
	import { error } from "$lib/stores/errors";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import type { Model } from "$lib/types/Model";
	import { UrlDependency } from "$lib/types/UrlDependency";
	import { safeInvalidate } from "$lib/utils/safeInvalidate";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonSearch from "~icons/carbon/search";

	interface Props {
		models: Model[];
		currentModel: Model;
		onclose: () => void;
	}

	let { models, currentModel, onclose }: Props = $props();

	const settings = useSettingsStore();
	const convsStore = useConversationsStore();

	let query = $state("");
	let busy = $state<string | null>(null);

	/** No conversation yet means the new-chat screen. See the module comment. */
	const conversationId = $derived(page.params?.id);

	const normalise = (value: string) => value.toLowerCase().trim();
	const tokens = $derived(normalise(query).split(/\s+/).filter(Boolean));

	const shown = $derived(
		models.filter((model) => {
			const haystack = normalise(`${model.id} ${model.name ?? ""} ${model.displayName ?? ""}`);
			return tokens.every((token) => haystack.includes(token));
		})
	);

	// A search box for three models is furniture. The threshold is low because
	// a deployment with a dozen agents reaches it quickly.
	const searchable = $derived(models.length > 6);

	const isAgent = (model: Model) => model.id.startsWith("agent:");

	async function choose(model: Model) {
		if (model.id === currentModel.id) {
			onclose();
			return;
		}
		busy = model.id;
		try {
			if (!conversationId) {
				// Nothing to pin yet. This is the same write the Models dialog's
				// "Set as default" makes, and it is correct here: on this screen
				// the default *is* what the chat about to be created starts on.
				// An agent card sets the wrapper as the default (the model sent
				// is the agent's underlying one, corrected server-side too);
				// picking a plain model is the explicit escape from a wrapper.
				settings.instantSet(
					isAgent(model)
						? { activeModel: model.id, activeAgentId: model.id.slice("agent:".length) }
						: { activeModel: model.id, activeAgentId: undefined },
				);
				onclose();
				return;
			}

			const response = await fetch(`${base}/conversation/${conversationId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				// The wire name is all the server needs: it resolves the
				// caller's own agent from it.
				body: JSON.stringify({ model: model.id }),
			});
			if (!response.ok) {
				let message = "Could not switch model";
				try {
					message = ((await response.json()) as { message?: string }).message ?? message;
				} catch {
					// The gateway can refuse with a non-JSON body — a model the
					// caller may not use answers 404 from `/v1`. Keep the generic
					// sentence rather than showing an HTML error page.
				}
				throw new Error(message);
			}
			// Both, for the reason in the module comment: the conversation and
			// the sidebar each hold the model.
			await Promise.all([safeInvalidate(UrlDependency.Conversation), convsStore.refresh()]);
			onclose();
		} catch (err) {
			console.error(err);
			error.set((err as Error).message);
			busy = null;
		}
	}
</script>

<Modal
	onclose={() => onclose()}
	width="w-[90dvw] md:{s.OVERLAY_NARROW}"
	labelledBy="model-picker-title"
>
	<div class={s.PANEL}>
		<div class={s.HEADER}>
			<h2 id="model-picker-title" class={s.TITLE}>Switch model</h2>
			<p class={s.SUBTITLE}>
				{#if conversationId}
					Changes this conversation only. Your default is untouched.
				{:else}
					Sets what this new chat starts on.
				{/if}
			</p>
		</div>

		{#if searchable}
			<div class="relative mb-4">
				<CarbonSearch
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
				/>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:value={query}
					class={s.SEARCH}
					placeholder="Search by name"
					aria-label="Search models"
					autofocus
				/>
			</div>
		{/if}

		<div class="max-h-[50dvh] space-y-2 overflow-y-auto">
			{#each shown as model (model.id)}
				{@const active = model.id === currentModel.id}
				<button
					type="button"
					onclick={() => choose(model)}
					disabled={busy !== null}
					class="{s.card(active)} {s.CARD_BODY} flex w-full items-center gap-3 text-left
						hover:border-blue-600/40 disabled:opacity-60"
					aria-current={active ? "true" : undefined}
				>
					{#if model.logoUrl}
						<img
							src={model.logoUrl}
							alt=""
							class="size-5 flex-none rounded-sm border bg-white dark:border-gray-700"
						/>
					{/if}
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-2">
							<span class={s.CARD_TITLE}>{model.displayName || model.name}</span>
						</span>
						<span class="{s.CARD_SUBTITLE} block">{model.id}</span>
					</span>
					{#if model.id.startsWith("agent:")}
						<span class="{s.PILL} {s.PILL_TONES.neutral}">Agent</span>
					{/if}
					{#if busy === model.id}
						<span class="loading-dots shrink-0 text-xs text-gray-500">Switching</span>
					{:else if active}
						<CarbonCheckmark class="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
					{/if}
				</button>
			{:else}
				<p class={s.EMPTY_DETAIL}>No model matches that.</p>
			{/each}
		</div>
	</div>
</Modal>
