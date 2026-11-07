<!--
	Assistant: what the deployment decides about the assistant itself —
	the instructions every chat starts from, whether it may hand work to
	sub-agents, and how the composer offers dictation, the model that draws images, and the model that names chats. Stacked as sections of
	one tab rather than three tabs; each keeps its own loading and saving.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import InstructionsSection from "$lib/components/admin/InstructionsSection.svelte";
	import SubAgentsSection from "$lib/components/admin/SubAgentsSection.svelte";
	import SlidesSection from "$lib/components/admin/SlidesSection.svelte";
	import VoiceSection from "$lib/components/admin/VoiceSection.svelte";
	import ImagesSection from "$lib/components/admin/ImagesSection.svelte";
	import TitleModelSection from "$lib/components/admin/TitleModelSection.svelte";
	import StartersSection from "$lib/components/admin/StartersSection.svelte";
	import HiddenModelsSection from "$lib/components/admin/HiddenModelsSection.svelte";
</script>

<svelte:head><title>{m["admin.assistant.page_title"]()}</title></svelte:head>

<div class="flex flex-col gap-6">
	<InstructionsSection />
	<SubAgentsSection />
	<VoiceSection />
	<ImagesSection />
	<SlidesSection />
	<TitleModelSection />
	<HiddenModelsSection />
	<StartersSection />
</div>
