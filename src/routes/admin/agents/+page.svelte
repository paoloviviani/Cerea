<!--
	Agents: what the deployment decides about coding agents. For now one switch, Auto-approval
	(ADR 0109): whether Auto may use a reviewer here. Each user sets their own reviewer in
	Workspace, Agents. Stacked as sections of one tab, like Assistant, so more can be added.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import AgentReviewSection from "$lib/components/admin/AgentReviewSection.svelte";
</script>

<svelte:head><title>{m["admin.auto.page_title"]()}</title></svelte:head>

<div class="flex flex-col gap-6">
	<AgentReviewSection />
</div>
