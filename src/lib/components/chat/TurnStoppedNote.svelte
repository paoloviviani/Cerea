<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import CarbonStopOutline from "~icons/carbon/stop-outline";
</script>

<!-- A turn the machine ended on purpose because the agent was repeating the same action (its
     limit for loops is "stop", ADR 0107). Neutral, not the error tone: nothing broke. -->
<div
	role="status"
	data-exclude-from-copy
	data-testid="turn-stopped-note"
	class="mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-xs text-ink-muted"
>
	<CarbonStopOutline class="mt-px size-3.5 shrink-0" />
	<span class="min-w-0 break-words">{m["chat.turn_stopped.loop"]()}</span>
</div>
