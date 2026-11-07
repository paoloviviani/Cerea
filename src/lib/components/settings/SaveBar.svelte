<!--
	The save bar of a settings page: a compact pill that floats at the foot of the
	page's own scrolling column, and only while there is something to save —
	"Unsaved changes · Discard · Save". It replaced a full-width band that sat
	under the form all the time, white on the page, whether anything had changed
	or not.

	The Save button submits the page's form (`form` is its id), so Enter in a
	field and the button do the same thing. After a save the pill says "Saved"
	for a moment and goes (the caller passes `saved`, and clears it).

	It must sit inside the scrolling column, as the last child of a box that is
	at least as tall as the viewport: `sticky` then keeps it at the bottom while
	the form scrolls under it.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** There are unsaved changes (or, on a create form, always). */
		dirty: boolean;
		/** Just saved: say so, without the buttons. Ignored while `dirty`. */
		saved?: boolean;
		busy?: boolean;
		/** The id of the form the Save button submits. */
		form: string;
		/** What Save is called here ("Save"; "Create project" on a create form). */
		saveLabel?: string;
		/** The label while busy. */
		busyLabel?: string;
		/** Save is not allowed yet (a required field is empty). */
		saveDisabled?: boolean;
		/** Absent on a create form: there is nothing to go back to. */
		ondiscard?: () => void;
		/** Hide the "Unsaved changes" words (a create form is unsaved by nature). */
		quiet?: boolean;
		/**
		 * A footer bar instead of a floating pill: full width of the column, a line
		 * above it, the button at the right. For a create form, where the button is
		 * the page's one action and must not float over the fields it follows.
		 */
		docked?: boolean;
	}

	let {
		dirty,
		saved = false,
		busy = false,
		form,
		saveLabel,
		busyLabel,
		saveDisabled = false,
		ondiscard,
		quiet = false,
		docked = false,
	}: Props = $props();
</script>

{#if docked && dirty}
	<div
		data-testid="save-bar"
		data-docked="true"
		class="sticky bottom-0 z-10 -mx-1 flex justify-end border-t border-line bg-surface/95 px-1 py-3 backdrop-blur"
	>
		<button
			type="submit"
			{form}
			disabled={busy || saveDisabled}
			class={s.PRIMARY}
			data-testid="save-bar-save"
		>
			{busy
				? (busyLabel ?? saveLabel ?? m["settings.save_bar.save"]())
				: (saveLabel ?? m["settings.save_bar.save"]())}
		</button>
	</div>
{:else if dirty || saved}
	<div class="pointer-events-none sticky bottom-3 z-10 flex justify-center px-2">
		<div
			role="group"
			aria-label={m["settings.save_bar.unsaved"]()}
			data-testid="save-bar"
			class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line bg-surface py-1.5 pr-1.5 pl-4 text-sm shadow-lg"
		>
			{#if dirty}
				{#if !quiet}
					<span class="text-ink-muted" role="status">{m["settings.save_bar.unsaved"]()}</span>
					<span class="text-ink-faint" aria-hidden="true">·</span>
				{/if}
				{#if ondiscard}
					<button
						type="button"
						onclick={ondiscard}
						disabled={busy}
						class="rounded-full px-2 py-1 text-ink-muted hover:text-ink disabled:opacity-50"
						data-testid="save-bar-discard"
					>
						{m["settings.save_bar.discard"]()}
					</button>
				{/if}
				<button
					type="submit"
					{form}
					disabled={busy || saveDisabled}
					class="{s.PRIMARY} !rounded-full !py-1 !pr-4 !pl-4"
					data-testid="save-bar-save"
				>
					{busy
						? (busyLabel ?? saveLabel ?? m["settings.save_bar.save"]())
						: (saveLabel ?? m["settings.save_bar.save"]())}
				</button>
			{:else}
				<span class="pr-3 text-ok" role="status">{m["settings.save_bar.saved"]()}</span>
			{/if}
		</div>
	</div>
{/if}
