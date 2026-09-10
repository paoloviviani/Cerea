<!--
	The overlay, as a page.

	This address predates the dialog and people link to it, so it is kept — but
	what it renders is the same `KnowledgeManager` the nav opens. One
	implementation and one design: a dialog for whoever arrives from the nav and
	a separate page for whoever arrives from a link is how the two drift apart.

	Closing navigates to the chat, because here the dialog *is* the page and
	"close" has nowhere else to mean.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import KnowledgeManager from "$lib/components/knowledge/KnowledgeManager.svelte";

	const id = $derived(page.params.id as string);
</script>

<KnowledgeManager initialId={id} onclose={() => goto(`${base}/`)} />
