<script lang="ts">
	import { m } from "$lib/paraglide/messages";

	/**
	 * A message an MCP App page suggests (docs/dev/adr-mcp-apps.md): shown above the composer, never written
	 * into it. The user inserts it or dismisses it.
	 */
	interface Props {
		from: string;
		text: string;
		oninsert: () => void;
		ondismiss: () => void;
	}

	let { from, text, oninsert, ondismiss }: Props = $props();
</script>

<div
	data-testid="app-suggestion"
	class="mb-2 flex w-full items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-100"
>
	<div class="min-w-0 flex-1">
		<p class="font-medium">{m["chat.mcp_app.suggests"]({ server: from })}</p>
		<p class="mt-0.5 line-clamp-3 break-words whitespace-pre-wrap">{text}</p>
	</div>
	<div class="flex shrink-0 gap-2 font-medium">
		<button type="button" class="hover:underline" onclick={oninsert}
			>{m["chat.mcp_app.insert"]()}</button
		>
		<button type="button" class="opacity-70 hover:underline" onclick={ondismiss}
			>{m["chat.mcp_app.dismiss"]()}</button
		>
	</div>
</div>
