<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { page } from "$app/state";
	import { base } from "$app/paths";
</script>

<div
	class="flex items-center justify-center bg-linear-to-t from-gray-200 text-gray-800 dark:from-gray-700 dark:text-gray-300"
>
	<div
		class="align-center -mt-24 flex flex-col justify-center rounded-xl border bg-white px-8 pt-4 pb-2 text-center dark:border-gray-700 dark:bg-gray-800"
	>
		<h1 class="mb-2 text-5xl font-semibold">{page.status}</h1>
		<div class="-mx-8 my-2 h-px bg-gray-200 dark:bg-gray-700"></div>
		{#if page.status === 404}
			<h2 class="max-w-sm text-lg">{m["error.not_found.title"]()}</h2>
			<p class="mt-1 max-w-sm text-sm">{m["error.not_found.text"]()}</p>
			<a
				href="{base}/"
				class="my-4 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
				>{m["error.not_found.chat_link"]()}</a
			>
		{:else}
			<h2 class="max-w-sm text-lg">{page.error?.message}</h2>
		{/if}
		{#if page.error?.errorId}
			<div class="-mx-8 my-2 h-px bg-gray-200 dark:bg-gray-700"></div>
			<pre class="max-w-sm text-left font-mono text-xs whitespace-pre-wrap">{page.error
					.errorId}</pre>
		{/if}
	</div>
</div>
