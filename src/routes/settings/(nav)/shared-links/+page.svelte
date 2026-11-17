<!-- The user's own public artifact links (ADR 0120). -->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import SharedLinksSettings from "$lib/components/sharing/SharedLinksSettings.svelte";
</script>

<svelte:head><title>{m["settings.tabs.shared_links"]()}</title></svelte:head>

<SharedLinksSettings />
