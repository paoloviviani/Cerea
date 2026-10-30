<!--
	Scheduled actions for everyone signed in: the list, the editor and each
	schedule's history, the same pane the /code panel shows (`SchedulesPanel`),
	here as a page of its own. A schedule's chat is reached from its history
	(`/conversation/<id>`), and "Schedule…" in a conversation's menu opens the
	editor on it (`?new=1&conversation=<id>`).
-->
<script lang="ts">
	import SchedulesPanel from "$lib/components/code/SchedulesPanel.svelte";
	import { m } from "$lib/paraglide/messages";
</script>

<svelte:head>
	<title>{m["code.schedules.title"]()}</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<SchedulesPanel standalone />
</div>
