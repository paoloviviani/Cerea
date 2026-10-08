<!--
	"Created by an agent in ‹session›": the tag an agent-made schedule carries
	in the list and the editor, linking to the session that made it. A
	person's schedule has no `createdBy` and renders nothing.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import IconBot from "~icons/carbon/bot";
	import type { ScheduleView } from "$lib/codeApi";

	interface Props {
		createdBy: ScheduleView["createdBy"];
		class?: string;
	}

	let { createdBy, class: className = "" }: Props = $props();

	const href = $derived(
		createdBy
			? `${base}/code?${new URLSearchParams({
					device: createdBy.deviceId,
					ws: createdBy.workspaceId,
					agent: createdBy.sessionId,
				}).toString()}`
			: ""
	);
</script>

{#if createdBy}
	<p
		class="flex min-w-0 items-start gap-1.5 text-xs text-ink-muted {className}"
		data-testid="schedule-created-by"
	>
		<IconBot class="mt-px size-3.5 shrink-0" aria-hidden="true" />
		<span class="min-w-0 break-words">
			Created by an agent in
			<a
				{href}
				class="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
				>{createdBy.title || "a session"}</a
			>
		</span>
	</p>
{/if}
