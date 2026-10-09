<script lang="ts">
	import CarbonWarning from "~icons/carbon/warning-alt";

	interface Props {
		/** Why the turn failed, as the machine's error event framed it
		 * (PROTOCOL.md §7): the provider's own text, with the one fix worth
		 * trying when the provider answered with an auth/payment status. */
		reason: string;
	}

	let { reason }: Props = $props();
</script>

<!-- Why a turn died, where it died — the state pill up top only says
     "error". The same card idiom TurnWaitBanner uses, in the error tone. -->
<div
	role="status"
	data-exclude-from-copy
	data-testid="turn-failed-reason"
	class="mt-2 flex w-fit max-w-full items-start gap-1.5 overflow-hidden rounded-lg border border-danger/25 bg-danger-subtle px-2.5 py-1.5 text-xs text-danger"
>
	<CarbonWarning class="mt-px size-3.5 shrink-0" />
	<span class="min-w-0 break-words">{reason}</span>
</div>
