<script lang="ts">
	import CarbonWarning from "~icons/carbon/warning-alt";
	import CarbonChevronRight from "~icons/carbon/chevron-right";

	interface Props {
		/** Why the turn failed, as the machine's error event framed it
		 * (PROTOCOL.md §7): the provider's own text, with the one fix worth
		 * trying when the provider answered with an auth/payment status. */
		reason: string;
		/** Whether this is the transcript's most recent failed turn: that one
		 * starts expanded (a failure has to be read once); older ones start
		 * collapsed to the one-line title, so a session that kept failing does
		 * not stack a paragraph per turn. The default keeps the open banner —
		 * the caller that knows the transcript's order passes the truth. */
		isLatest?: boolean;
	}

	let { reason, isLatest = true }: Props = $props();

	// The transcript's most recent failure starts expanded; older ones start
	// collapsed to the one-line title — a session that kept failing does not
	// stack a paragraph per turn. A manual toggle wins from then on: the
	// reader's fold (or reopening) survives until they change it again.
	let toggled: boolean | undefined = $state();
	let open = $derived(toggled ?? isLatest);
</script>

<!-- Why a turn died, where it died — the state pill up top only says
     "error". The same card idiom TurnWaitBanner uses, in the error tone;
     the chevron is the PlanCard idiom. -->
<div
	role="status"
	data-exclude-from-copy
	data-testid="turn-failed-reason"
	class="mt-2 flex w-fit max-w-full items-start gap-1.5 overflow-hidden rounded-lg border border-danger/25 bg-danger-subtle px-2.5 py-1.5 text-xs text-danger"
>
	<CarbonWarning class="mt-px size-3.5 shrink-0" />
	<span class="min-w-0 {open ? 'break-words' : 'truncate'}" title={reason}>{reason}</span>
	<button
		type="button"
		onclick={() => (toggled = !open)}
		aria-expanded={open}
		aria-label={open ? "Collapse the failure detail" : "Expand the failure detail"}
		data-testid="turn-failed-toggle"
		class="mt-px shrink-0 cursor-pointer rounded-sm p-0.5 text-danger/70 transition-colors hover:text-danger focus:outline-hidden"
	>
		<CarbonChevronRight
			class="size-3 transition-transform duration-200 {open ? 'rotate-90' : ''}"
		/>
	</button>
</div>
