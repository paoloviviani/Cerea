<!--
	The engine's small mark beside its name in the Agents panel: a pixel "M" for
	Mistral Vibe, a plain terminal glyph for any other engine. Decorative (the
	name is always next to it), so it is hidden from assistive technology.
-->
<script lang="ts">
	import IconTerminal from "~icons/carbon/terminal";
	import type { EngineKey } from "$lib/utils/engineLabel";

	interface Props {
		engine: EngineKey;
		class?: string;
	}
	let { engine, class: className = "size-4" }: Props = $props();
</script>

{#if engine === "vibe"}
	<svg
		class={className}
		viewBox="0 0 15 15"
		fill="currentColor"
		aria-hidden="true"
		data-testid="engine-icon-vibe"
	>
		<rect x="1" y="2" width="3" height="11" />
		<rect x="11" y="2" width="3" height="11" />
		<rect x="4" y="4" width="2" height="3" />
		<rect x="9" y="4" width="2" height="3" />
		<rect x="6" y="6" width="3" height="3" />
	</svg>
{:else}
	<IconTerminal class={className} aria-hidden="true" data-testid="engine-icon" />
{/if}
