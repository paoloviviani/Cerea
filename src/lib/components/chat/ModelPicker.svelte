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
	 *
	 * The list, search and layout are `ModelPickerDialog` (shared with /code's
	 * "More models"); this file is only the business logic behind a pick.
	 */
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import ModelPickerDialog from "$lib/components/ModelPickerDialog.svelte";
	import { error } from "$lib/stores/errors";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import type { Model } from "$lib/types/Model";
	import { UrlDependency } from "$lib/types/UrlDependency";
	import { safeInvalidate } from "$lib/utils/safeInvalidate";
	import type { PickerModel } from "$lib/utils/modelEffortPicker";

	interface Props {
		models: Model[];
		currentModel: Model;
		onclose: () => void;
	}

	let { models, currentModel, onclose }: Props = $props();

	const settings = useSettingsStore();
	const convsStore = useConversationsStore();

	let busy = $state<string | null>(null);

	/** No conversation yet means the new-chat screen. See the module comment. */
	const conversationId = $derived(page.params?.id);

	const pickerModels = $derived<PickerModel[]>(
		models.map((model) => ({
			id: model.id,
			name: model.displayName || model.name,
			description: model.description,
			logoUrl: model.logoUrl,
		}))
	);

	async function choose(id: string) {
		busy = id;
		try {
			if (!conversationId) {
				// Nothing to pin yet. This is the same write the Models dialog's
				// "Set as default" makes, and it is correct here: on this screen
				// the default *is* what the chat about to be created starts on.
				settings.instantSet({ activeModel: id });
				onclose();
				return;
			}

			const response = await fetch(`${base}/conversation/${conversationId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
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

<ModelPickerDialog
	models={pickerModels}
	currentId={currentModel.id}
	title="Switch model"
	subtitle={conversationId
		? "Changes this conversation only. Your default is untouched."
		: "Sets what this new chat starts on."}
	{busy}
	onchoose={choose}
	{onclose}
/>
