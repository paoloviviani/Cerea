<!--
	"A new version is available": shown when the version poll (`kit.version` in
	svelte.config.js) finds the server now serves a different build than this tab
	loaded. Non-blocking; the tab keeps working, and the next navigation already
	loads in full (root layout). Reload does it now.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { reloadApp } from "$lib/utils/appReload";

	interface Props {
		show: boolean;
	}

	let { show }: Props = $props();
</script>

{#if show}
	<div
		role="status"
		data-testid="update-banner"
		class="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
	>
		<span>{m["app.update_banner.message"]()}</span>
		<button
			type="button"
			onclick={reloadApp}
			class="rounded-md bg-blue-600 px-2 py-0.5 font-medium text-white hover:bg-blue-700"
		>
			{m["app.update_banner.reload"]()}
		</button>
	</div>
{/if}
