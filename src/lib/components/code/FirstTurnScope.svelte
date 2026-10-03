<!--
	Tells the approval card below it that its ask comes from a subagent (its
	session is not the root's), so the card can say a new subagent's first turn
	asks whatever the setting is (`firstTurnSubagent`). A wrapper because the
	inbox's cards carry no child id of their own and a context is set at
	initialisation, once per ask. Anything that is not a subagent's ask sets
	nothing, and the card draws no chip.
-->
<script lang="ts">
	import { setContext, type Snippet } from "svelte";
	import { fetchSubagentTimeline } from "$lib/codeApi";
	import { FIRST_TURN_SUBAGENT } from "$lib/utils/firstTurnSubagent";
	import { FirstTurnTracker } from "$lib/utils/firstTurnTracker.svelte";

	interface Props {
		deviceId: string;
		/** The top-level session the subagent belongs to, when known. */
		rootId?: string;
		/** The session that asked. */
		childId: string;
		children: Snippet;
	}

	let { deviceId, rootId, childId, children }: Props = $props();

	// Initialisation reads on purpose: an item's device, root and child never
	// change for the life of its card.
	// svelte-ignore state_referenced_locally
	if (rootId && rootId !== childId) {
		setContext(
			FIRST_TURN_SUBAGENT,
			new FirstTurnTracker(
				async (id) => (await fetchSubagentTimeline(deviceId, rootId, id)).updates,
				childId
			)
		);
	}
</script>

{@render children()}
