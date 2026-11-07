<!--
	Scheduled actions for everyone signed in, chats and coding agents on one page:
	the list (filtered All · Chats · Agents), the editor and each schedule's
	history (`SchedulesPanel`). A schedule's chat is reached from its history
	(`/conversation/<id>`), and "Schedule…" in a conversation's menu opens the
	editor on it (`?new=1&conversation=<id>`). The old agent address,
	`/code?view=schedules`, redirects here with `?kind=agent`.
-->
<script lang="ts">
	import SchedulesPanel from "$lib/components/code/SchedulesPanel.svelte";
	import { m } from "$lib/paraglide/messages";
</script>

<svelte:head>
	<title>{m["code.schedules.title"]()}</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<SchedulesPanel />
</div>
