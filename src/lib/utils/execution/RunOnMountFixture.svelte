<script lang="ts">
	// A code card: starts its run in an effect when it mounts.
	let { run }: { run: () => void } = $props();
	let kicked = false;
	$effect(() => {
		if (kicked) return;
		kicked = true;
		run();
	});
</script>
