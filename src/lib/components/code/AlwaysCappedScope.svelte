<!--
	Tells the approval cards below it which tools the machine's ceiling holds
	below allow, so they hide "Always allow (this session)" for them
	(`ALWAYS_CAPPED`). A wrapper because a context is set at initialisation and
	the inbox needs a different answer per card (each ask's own machine).
-->
<script lang="ts">
	import { setContext, type Snippet } from "svelte";
	import { ALWAYS_CAPPED, type AlwaysCapped } from "$lib/utils/alwaysCappedContext";

	interface Props {
		capped: AlwaysCapped;
		children: Snippet;
	}

	let { capped, children }: Props = $props();

	// Read through the prop at call time, so a ceiling that arrives or changes
	// after the card mounted is still honoured.
	setContext<AlwaysCapped>(ALWAYS_CAPPED, (tool) => capped(tool));
</script>

{@render children()}
