<!--
	Web: the two halves of how the assistant reaches the open web, stacked as
	sections of one tab — which backend searches, and which backend fetches a
	URL. They were separate tabs; two short forms do not each need a tab, and
	the tab row no longer wraps. Each section keeps its own loading and saving,
	so nothing here is shared between them.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import WebSearchSection from "$lib/components/admin/WebSearchSection.svelte";
	import FetchSection from "$lib/components/admin/FetchSection.svelte";
</script>

<svelte:head><title>{m["admin.web.page_title"]()}</title></svelte:head>

<div class="flex flex-col gap-6">
	<WebSearchSection />
	<FetchSection />
</div>
