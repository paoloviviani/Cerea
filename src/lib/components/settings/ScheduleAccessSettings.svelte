<!--
	Settings → Application: the background access scheduled chats run on.

	A chat schedule runs while its owner is away, so it needs an access of its own to the
	deployment's models (an OIDC refresh token the person gave once). This shows whether it is
	given, how many chat schedules depend on it, and revokes it: the access is revoked at the
	identity provider where that can be, and the chat schedules switch off until it is given again.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { m } from "$lib/paraglide/messages";
	import {
		getScheduleGrant,
		revokeScheduleGrant,
		type ScheduleGrantStatus,
	} from "$lib/scheduleGrantApi";

	let status = $state<ScheduleGrantStatus | null>(null);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let revokedNote = $state<number | null>(null);

	async function load() {
		try {
			status = await getScheduleGrant();
		} catch {
			status = null;
		}
	}
	onMount(() => void load());

	async function revoke() {
		busy = true;
		failure = null;
		try {
			const { disabled } = await revokeScheduleGrant();
			revokedNote = disabled;
			await load();
		} catch (err) {
			failure =
				err instanceof Error ? err.message : m["settings.schedule_access.could_not_revoke"]();
		} finally {
			busy = false;
		}
	}
</script>

{#if status?.required}
	<div class="mt-6 flex flex-col gap-1.5" data-testid="schedule-access">
		<h2 class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
			{m["settings.schedule_access.title"]()}
		</h2>
		<p class="text-xs text-gray-500 dark:text-gray-400">
			{status.granted
				? m["settings.schedule_access.granted"]({ count: status.chatSchedules })
				: m["settings.schedule_access.not_granted"]()}
		</p>
		{#if status.granted}
			<button
				type="button"
				class="self-start rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
				disabled={busy}
				onclick={revoke}
				data-testid="schedule-access-revoke"
			>
				{m["settings.schedule_access.revoke"]()}
			</button>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{m["settings.schedule_access.revoke_hint"]()}
			</p>
		{/if}
		{#if revokedNote !== null && !status.granted}
			<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="schedule-access-revoked">
				{m["settings.schedule_access.revoked"]({ count: revokedNote })}
			</p>
		{/if}
		{#if failure}
			<p class="text-xs text-red-600 dark:text-red-400" role="alert">{failure}</p>
		{/if}
	</div>
{/if}
