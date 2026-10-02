<!--
	The one thing /code shows while the sign-in is too old: a card that says so
	and offers the way back. No machine, no count, no list — the server refuses
	everything but `/status` in this state, and the panel has already dropped
	what it held (`codeReauth`).

	[Sign in] is a plain link to the path `/status` named (it already carries
	the app's base path and forces the identity provider to authenticate
	again). Coming back lands on /code, which asks `/status` afresh.
-->
<script lang="ts">
	import IconCode from "~icons/carbon/code";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import * as s from "$lib/components/overlay/styles";
</script>

<div
	class="pointer-events-auto scrollbar-custom flex min-h-0 flex-1 overflow-y-auto p-8 sm:p-24"
	data-testid="code-reauth-card"
>
	<div
		class="m-auto flex w-full max-w-sm flex-col items-center rounded-lg border-2 border-dashed border-line-strong px-8 py-10 text-center sm:px-14 sm:py-14"
	>
		<IconCode class="mb-3 size-7 text-ink-faint" />
		<p class="mb-1 text-xs font-medium text-ink">Sign in again</p>
		<p class="mb-4 text-xs text-ink-muted">
			Your sign-in is older than 7 days. Sign in again to see your machines.
		</p>
		<a href={codeReauth.reauthPath} class={s.PRIMARY} data-sveltekit-reload>Sign in</a>
	</div>
</div>
