<!--
	Deployment skills, managed.

	The definitions are shared with every account and the sharing is
	trivially safe — a skill holds no secrets, only a procedure — which is
	why this lives beside the connectors section rather than in the gateway's
	console: it is a decision about what the product does, not about how the
	platform is run. Who may be here is the gateway's decision, enforced on
	every write server-side; the layout's gate is for navigation, never a
	permission.
-->
<script lang="ts">
	import SkillsManager from "$lib/components/skills/SkillsManager.svelte";
</script>

<svelte:head><title>Skills · administration</title></svelte:head>

<div class="rounded-lg border border-gray-200 dark:border-gray-700">
	<SkillsManager admin />
</div>
