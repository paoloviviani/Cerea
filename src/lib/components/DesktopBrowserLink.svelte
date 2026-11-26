<!--
	Links this page to the desktop app's own browser, when the page runs inside the app (ADR 0122).
	Renders nothing. Mounted once, in the app shell, for a signed-in user.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { startDesktopBrowserLink } from "$lib/utils/desktopBrowser";

	onMount(() => startDesktopBrowserLink({ base }));
</script>
