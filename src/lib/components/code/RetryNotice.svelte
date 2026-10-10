<script lang="ts">
	import { onMount } from "svelte";

	interface Props {
		/** The machine's retry facts (PROTOCOL.md §7): `next` is epoch ms. */
		retry: { attempt: number; message: string; next?: number };
	}

	let { retry }: Props = $props();

	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	// A countdown only when the machine's clock and ours plausibly agree: a
	// next try in the past (we are late) reads "now", one an hour out is skew.
	let seconds = $derived.by(() => {
		if (!retry.next) return undefined;
		const left = Math.ceil((retry.next - now) / 1000);
		return left > 3600 ? undefined : Math.max(0, left);
	});
	let when = $derived(
		seconds === undefined ? "" : seconds === 0 ? ", trying again now" : `, next try in ${seconds} s`
	);
</script>

<span
	class="flex items-center gap-1.5 truncate pl-6 text-xs text-ink-muted"
	data-testid="retry-notice"
>
	<span class="size-2 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
	<span class="truncate">
		Retrying — {retry.message || "the model's provider did not answer"} (attempt {retry.attempt}{when})
	</span>
</span>
