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
		/** The root session's permission mode, when the surface showing the
		 * card knows it. Absent means unknown, and the chip stays hidden. */
		rootMode?: string | null;
		children: Snippet;
	}

	let { deviceId, rootId, childId, rootMode, children }: Props = $props();

	// The tracker instance is created once at init (setContext only runs
	// there), but rootMode arrives later — the inbox learns it from a
	// snapshot read after the poll — so an effect keeps it current. Until
	// it arrives the chip stays hidden rather than guessing.
	let tracker: FirstTurnTracker | undefined = undefined;
	// svelte-ignore state_referenced_locally
	if (rootId && rootId !== childId) {
		tracker = new FirstTurnTracker(
			async (id) => (await fetchSubagentTimeline(deviceId, rootId, id)).updates,
			childId
		);
		setContext(FIRST_TURN_SUBAGENT, tracker);
	}
	$effect(() => {
		if (tracker) tracker.rootMode = rootMode ?? null;
	});
</script>

{@render children()}
