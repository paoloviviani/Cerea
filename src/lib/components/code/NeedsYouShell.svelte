<!--
	The app-wide Needs-you bar: the inbox, mounted at the top of the main
	column of every page but /code (which draws its own). It exists only for a
	user with /code enabled and a sign-in known to be fresh, so a deployment
	without /code, a stale sign-in, or a page that has no business showing it
	costs no request. The inbox draws nothing until an ask is pending, and
	reads only while the tab is visible (see `NeedsYouInbox`).

	Left out: /code (the inbox is part of that page) and the sign-in routes.
	Settings and the other pages are ordinary pages here, not overlays, so
	the bar sits above them like anywhere else.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import { useCodeDevicePoll } from "$lib/stores/codeDeviceList.svelte";
	import NeedsYouInbox from "./NeedsYouInbox.svelte";

	interface Props {
		/** Deployment flag + user: /code is available at all. */
		enabled: boolean;
	}

	let { enabled }: Props = $props();

	const route = $derived(page.route.id ?? "");
	const excluded = $derived(
		route === "/code" || route.startsWith("/login") || route.startsWith("/logout")
	);
	const show = $derived(enabled && !excluded && codeReauth.checked && !codeReauth.required);

	// The shared device poll runs only while the bar can show; it stops the
	// moment the sign-in goes stale or the user opens /code.
	$effect(() => {
		if (show) return useCodeDevicePoll();
	});
</script>

{#if show}
	<NeedsYouInbox publish scroll />
{/if}
