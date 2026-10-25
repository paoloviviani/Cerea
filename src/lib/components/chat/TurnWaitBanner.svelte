<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import CarbonTime from "~icons/carbon/time";
	import CarbonContinue from "~icons/carbon/continue";
	import { base } from "$app/paths";
	import { serverCorrectedNow } from "$lib/utils/clockSkew.svelte";

	interface Props {
		/** Absolute deadline, epoch ms (server clock). */
		until: number;
		reason?: string;
		/** Cutting the wait short is an action, so it needs the live conversation. */
		conversationId?: string;
		messageId?: string;
		/**
		 * Whether this view may act on the turn (not a read-only view).
		 */
		canWake?: boolean;
	}

	let { until, reason, conversationId, messageId, canWake = false }: Props = $props();

	// Past the deadline by more than the sweeper's cadence, "counting down" would
	// be a lie — say what is actually happening instead.
	const OVERDUE_GRACE_MS = 15_000;

	let now = $state(serverCorrectedNow());
	$effect(() => {
		const timer = setInterval(() => {
			now = serverCorrectedNow();
		}, 1000);
		return () => clearInterval(timer);
	});

	let remainingMs = $derived(until - now);
	let overdue = $derived(remainingMs < -OVERDUE_GRACE_MS);

	// Stays set once the wake is accepted: the banner is replaced by the resumed
	// turn's own output when the `running` state arrives, so there is nothing to
	// count down to in the meantime.
	let waking = $state(false);
	let wakeError = $state<string | undefined>(undefined);

	let showWakeButton = $derived(
		canWake && Boolean(conversationId && messageId) && !overdue && !waking
	);

	async function wakeNow() {
		if (!conversationId || !messageId || waking) return;
		waking = true;
		wakeError = undefined;
		try {
			const res = await fetch(`${base}/conversation/${conversationId}/wake`, {
				method: "POST",
				// Without Accept, SvelteKit answers `error()` with an HTML page.
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ messageId }),
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			// The timer is untouched by a failed request, so the turn still wakes
			// on its own — say so rather than implying the wait is lost.
			waking = false;
			wakeError = m["chat.wait.wake_failed"]();
		}
	}

	function formatRemaining(ms: number): string {
		const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}
</script>

{#snippet time(text: string)}<span class="font-mono tabular-nums">{text}</span>{/snippet}

<div
	role="status"
	data-exclude-from-copy
	class="mt-2 flex w-fit items-stretch overflow-hidden rounded-lg border border-gray-200 bg-gray-50 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
>
	<div class="flex items-center gap-1.5 px-2.5 py-1.5">
		<CarbonTime class="text-[0.8rem] {overdue ? '' : 'animate-pulse'}" />
		{#if overdue}
			<span>{reason ? m["chat.wait.late_for"]({ reason }) : m["chat.wait.late"]()}</span>
		{:else if waking}
			<span>{reason ? m["chat.wait.checking_for"]({ reason }) : m["chat.wait.checking"]()}</span>
		{:else}
			<span>
				<Rich
					parts={(reason ? m["chat.wait.resumes_for"] : m["chat.wait.resumes"]).parts({
						reason: reason ?? "",
						remaining: formatRemaining(remainingMs),
					})}
					tags={{ time }}
				/>
			</span>
		{/if}
		{#if wakeError}
			<span class="text-red-500 dark:text-red-400">{wakeError}</span>
		{/if}
	</div>
	{#if showWakeButton}
		<button
			type="button"
			onclick={wakeNow}
			aria-label={m["chat.wait.check_now"]()}
			title={m["chat.wait.check_now_title"]()}
			class="flex cursor-pointer items-center justify-center border-l border-gray-200 px-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:border-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
		>
			<CarbonContinue class="text-[0.7rem]" />
		</button>
	{/if}
</div>
