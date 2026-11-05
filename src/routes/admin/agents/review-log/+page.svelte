<!--
	The reviewer's log, on its own page under Agents: a record of what the reviewer decided, not a
	setting. Reached from the Auto-approval section; the store and API are the same as before.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import AgentReviewLog from "$lib/components/admin/AgentReviewLog.svelte";
</script>

<svelte:head
	><title>{m["admin.auto.log.title"]()} · {m["admin.layout.section.agents"]()}</title></svelte:head
>

<div class="flex flex-col gap-4">
	<a href="{base}/admin/agents" class="text-sm underline" data-testid="auto-log-back"
		>{m["admin.auto.log.back"]()}</a
	>
	<AgentReviewLog />
</div>
