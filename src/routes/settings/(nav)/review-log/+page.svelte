<!--
	The user's own view of the Auto reviewer's decisions (ADR 0107): the same log component as the
	administrator's, read through the user-scoped endpoint.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { m } from "$lib/paraglide/messages";
	import AgentReviewLog from "$lib/components/admin/AgentReviewLog.svelte";
</script>

<svelte:head><title>{m["settings.tabs.review_log"]()}</title></svelte:head>

{#if page.data.user && page.data.codeAgentsEnabled}
	<AgentReviewLog scope="own" />
{:else}
	<div
		class="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500 shadow-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
	>
		{m["settings.review_log.unavailable"]()}
	</div>
{/if}
