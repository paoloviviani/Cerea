<!--
	Assistant: what the deployment decides about the assistant itself —
	the instructions every chat starts from, whether it may hand work to
	sub-agents, and how the composer offers dictation. Stacked as sections of
	one tab rather than three tabs; each keeps its own loading and saving.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import InstructionsSection from "$lib/components/admin/InstructionsSection.svelte";
	import SubAgentsSection from "$lib/components/admin/SubAgentsSection.svelte";
	import VoiceSection from "$lib/components/admin/VoiceSection.svelte";
</script>

<svelte:head><title>{m["admin.assistant.page_title"]()}</title></svelte:head>

<div class="flex flex-col gap-6">
	<InstructionsSection />
	<SubAgentsSection />
	<VoiceSection />
</div>
