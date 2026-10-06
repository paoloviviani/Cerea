<!--
	A project's page. Keyed on the id so moving between projects remounts it,
	which is what "a fresh page" has always meant here.
-->
<script lang="ts">
	import { page } from "$app/state";
	import ProjectPage from "$lib/components/projects/ProjectPage.svelte";
</script>

{#key page.params.id}
	<ProjectPage id={page.params.id} />
{/key}
