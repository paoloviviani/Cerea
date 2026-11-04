<!--
	Agent auto-approval (ADR 0107 section 2): who answers a machine's permission asks while a session
	is on Auto. One screen: the reviewer's on/off, model, threshold and instructions, the per-class
	rows, the hourly cap, and the reviewer's log.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import AgentReviewSection from "$lib/components/admin/AgentReviewSection.svelte";
</script>

<svelte:head><title>{m["admin.auto.page_title"]()}</title></svelte:head>

<AgentReviewSection />
