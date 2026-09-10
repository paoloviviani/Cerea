<!--
	The overlay, as a page.

	This address predates the dialog and people link to it, so it is kept — but
	what it renders is the same `AgentsManager` the nav opens. One
	implementation and one design: a dialog for whoever arrives from the nav and
	a separate page for whoever arrives from a link is how the two drift apart.

	Closing navigates to the chat, because here the dialog *is* the page and
	"close" has nowhere else to mean.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import AgentsManager from "$lib/components/agents/AgentsManager.svelte";
</script>

<AgentsManager onclose={() => goto(`${base}/`)} />
