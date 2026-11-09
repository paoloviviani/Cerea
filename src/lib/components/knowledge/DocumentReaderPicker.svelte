<!--
	Which reader turns a PDF, an image or an Office file into text. The readers
	are the gateway's OCR models this user may use, listed as the gateway gives
	them; "Default" follows the deployment's default reader (the administrator's
	choice, named when known). It stays a picker even with a single option;
	plain text only when there is nothing at all to offer.

	Used on the knowledge base create form and in base settings (`value` bound,
	`onchange` saves), in a user's settings, and beside a document's "Re-read
	with…". Past chats are text and never extracted, so they have none.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		id?: string;
		/** Reader models this user may use. */
		models: string[];
		/** The deployment's default reader, when one resolves. */
		defaultReader: string | null;
		/** The choice: a model id, or "" for the default. */
		value?: string;
		/** The label above the select; omit for "Read documents with". */
		label?: string;
		/** Show the name only (a member who may not change it). */
		readonly?: boolean;
		disabled?: boolean;
		/** A short line under the select. */
		hint?: string;
		onchange?: (choice: string) => void;
	}

	let {
		id = "document-reader",
		models,
		defaultReader,
		value = $bindable(""),
		label,
		readonly = false,
		disabled = false,
		hint,
		onchange,
	}: Props = $props();

	// A reader chosen earlier that this viewer cannot list: shown as itself,
	// never as "Default".
	const unlisted = $derived(value && !models.includes(value) ? value : null);
	const defaultLabel = $derived(
		defaultReader
			? m["knowledge.reader.default"]({ name: defaultReader })
			: m["knowledge.reader.default_plain"]()
	);

	function pick(event: Event) {
		const choice = (event.currentTarget as HTMLSelectElement).value;
		value = choice;
		onchange?.(choice);
	}
</script>

<div data-testid="document-reader">
	<label for={id} class={s.LABEL}>{label ?? m["knowledge.reader.label"]()}</label>
	{#if readonly}
		<p {id} class="text-sm text-ink">{value || defaultLabel}</p>
	{:else}
		<select {id} class={s.INPUT} {disabled} {value} onchange={pick}>
			<option value="">{defaultLabel}</option>
			{#if unlisted}
				<option value={unlisted}>{unlisted}</option>
			{/if}
			{#each models as model (model)}
				<option value={model}>{model}</option>
			{/each}
		</select>
	{/if}
	{#if hint}
		<p class={s.HINT}>{hint}</p>
	{/if}
</div>
