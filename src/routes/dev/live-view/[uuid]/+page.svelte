<!--
	Internal, dev-only (404 in a production build): the one entry point that exercises the
	live-view module. Placeholder markup and wording: the real surfaces are not decided.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { LiveViewSession } from "$lib/liveView/liveViewSession.svelte";

	let { data } = $props();
	const session = $derived(
		new LiveViewSession(`/api/v2/browse/live/${encodeURIComponent(data.uuid)}`)
	);
	let canvas = $state<HTMLCanvasElement>();
	let field = $state<HTMLTextAreaElement>();

	onMount(() => {
		if (!canvas || !field) return;
		session.attachCanvas(canvas);
		session.attachKeyboard(field);
		session.connect(Math.min(1600, window.innerWidth * (window.devicePixelRatio || 1)));
		return () => session.disconnect();
	});
</script>

<div class="p-2 text-sm">
	<pre data-testid="dev-live-info">{JSON.stringify(
			{ status: session.status, controller: session.controller, info: session.info },
			null,
			1
		)}</pre>
	<button onclick={() => session.takeover()}>takeover</button>
	<button onclick={() => session.handBack()}>hand back</button>
	{#if session.error}<span>{session.error}</span>{/if}
	<canvas bind:this={canvas} class="max-w-full border" onpointerup={() => field?.focus()}></canvas>
	<textarea bind:this={field} class="size-px opacity-0" aria-label="keyboard"></textarea>
</div>
