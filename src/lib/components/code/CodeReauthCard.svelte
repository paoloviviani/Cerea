<!--
	The one thing /code shows while the sign-in cannot be used: a card that
	says why and offers the way back. No machine, no count, no list — the
	server refuses everything but `/status` in this state, and the panel has
	already dropped what it held (`codeReauth`).

	Two variants: a stale sign-in (older than 7 days) goes back through a
	forced re-login (`reauthPath`); no session at all (the ordinary hourly
	expiry) goes through the plain sign-in (`signInPath`), so the identity
	provider's SSO session answers silently instead of asking for the
	password again.
-->
<script lang="ts">
	import IconCode from "~icons/carbon/code";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import * as s from "$lib/components/overlay/styles";
</script>

<div
	class="pointer-events-auto scrollbar-custom flex min-h-0 flex-1 overflow-y-auto p-8 sm:p-24"
	data-testid="code-reauth-card"
	data-variant={codeReauth.signedOut ? "signed-out" : "stale"}
>
	<div
		class="m-auto flex w-full max-w-sm flex-col items-center rounded-lg border-2 border-dashed border-line-strong px-8 py-10 text-center sm:px-14 sm:py-14"
	>
		<IconCode class="mb-3 size-7 text-ink-faint" />
		{#if codeReauth.signedOut}
			<p class="mb-1 text-xs font-medium text-ink">Sign in again</p>
			<p class="mb-4 text-xs text-ink-muted">
				You were signed out. Sign in again to see your machines.
			</p>
			<a href={codeReauth.signInPath} class={s.PRIMARY} data-sveltekit-reload>Sign in</a>
		{:else}
			<p class="mb-1 text-xs font-medium text-ink">Sign in again</p>
			<p class="mb-4 text-xs text-ink-muted">
				Your sign-in is older than 7 days. Sign in again to see your machines.
			</p>
			<a href={codeReauth.reauthPath} class={s.PRIMARY} data-sveltekit-reload>Sign in</a>
		{/if}
	</div>
</div>
