<!--
	Which embedding model a knowledge base (or a project's past-chats index) is
	built with. The deployment's default is one option, labelled as such; the
	rest are the embedding models this user may use. With nothing to choose
	between it is plain text.

	Two uses. On a create form, `value` is bound and nothing else happens. On
	an existing index, pass `confirmCount`: picking another model then asks,
	inline, before anything is re-embedded, and `onconfirm` runs the reindex
	with the new choice. `readonly` (a member who may not manage the base) shows
	the name only.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		id?: string;
		/** Embedding models this user may use. */
		models: string[];
		/** The deployment's default model, if one is set. */
		defaultModel: string | null;
		/** The choice: a model name, or "" for the default. */
		value?: string;
		/** The model the base is built with now, shown as text when readonly. */
		current?: string | null;
		readonly?: boolean;
		disabled?: boolean;
		/** Set on an existing index: the number of documents a change re-embeds. */
		confirmCount?: number;
		onconfirm?: (choice: string) => void;
	}

	let {
		id = "embedding-model",
		models,
		defaultModel,
		value = $bindable(""),
		current = null,
		readonly = false,
		disabled = false,
		confirmCount,
		onconfirm,
	}: Props = $props();

	let pending = $state<string | null>(null);

	const others = $derived(models.filter((model) => model !== defaultModel));
	const single = $derived(
		models.length + (defaultModel && !models.includes(defaultModel) ? 1 : 0) <= 1
	);
	const defaultLabel = $derived(
		defaultModel
			? m["knowledge.embedder.default"]({ name: defaultModel })
			: m["knowledge.embedder.default_plain"]()
	);
	const plain = $derived(current || defaultModel || models[0] || "");

	function pick(event: Event) {
		const choice = (event.currentTarget as HTMLSelectElement).value;
		if (confirmCount === undefined) {
			value = choice;
			return;
		}
		pending = choice === value ? null : choice;
	}

	function confirm() {
		if (pending === null) return;
		const choice = pending;
		pending = null;
		onconfirm?.(choice);
	}
</script>

<div data-testid="embedding-model">
	<label for={id} class={s.LABEL}>{m["knowledge.embedder.label"]()}</label>
	{#if readonly || single}
		<p {id} class="text-sm text-ink">{plain}</p>
	{:else}
		<select {id} class={s.INPUT} {disabled} value={pending ?? value} onchange={pick}>
			<option value="">{defaultLabel}</option>
			{#each others as model (model)}
				<option value={model}>{model}</option>
			{/each}
		</select>
	{/if}
	{#if pending !== null}
		<div
			class="mt-2 flex flex-wrap items-center gap-2"
			role="group"
			data-testid="embedding-confirm"
		>
			<p class="{s.HINT} !mt-0">{m["knowledge.embedder.confirm"]({ count: confirmCount ?? 0 })}</p>
			<button type="button" class={s.PRIMARY} {disabled} onclick={confirm}>
				{m["knowledge.embedder.confirm_yes"]()}
			</button>
			<button type="button" class={s.SECONDARY} onclick={() => (pending = null)}>
				{m["knowledge.embedder.cancel"]()}
			</button>
		</div>
	{/if}
</div>
