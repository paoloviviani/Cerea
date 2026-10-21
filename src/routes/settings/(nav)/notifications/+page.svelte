<script lang="ts">
	import { page } from "$app/state";
	import NotificationSettings from "$lib/components/settings/NotificationSettings.svelte";
</script>

{#if page.data.user}
	<NotificationSettings />
{:else}
	<div
		class="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500 shadow-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
	>
		Sign in to get notifications.
	</div>
{/if}
