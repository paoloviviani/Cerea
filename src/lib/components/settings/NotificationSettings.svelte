<!--
	Settings → Notifications: turn push on for this device, choose which events
	notify, see and remove this person's devices, send a test.

	Honest about where it cannot work: a deployment without keys, a browser
	without push, an iPhone where the app is not on the Home Screen, a site the
	browser has blocked. The permission prompt appears only on the click.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import Switch from "$lib/components/Switch.svelte";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import { formatDateTime } from "$lib/i18n/format";
	import { PUSH_EVENTS, type PushEvent } from "$lib/utils/pushEvents";
	import {
		PushClientError,
		currentSubscription,
		enableThisDevice,
		errorMessage,
		fingerprintOf,
		pushSupport,
		type PushSupport,
	} from "$lib/utils/pushClient";

	interface Device {
		id: string;
		label: string;
		fingerprint: string;
		createdAt: string;
		lastPushAt: string | null;
	}
	interface State {
		configured: boolean;
		events: Record<PushEvent, boolean>;
		devices: Device[];
	}

	// One label and description per event, as messages: the event list itself
	// (`PUSH_EVENTS`) is shared with the server, which has no use for words.
	const EVENT_LABELS: Record<PushEvent, { label: () => string; description: () => string }> = {
		permission: {
			label: m["settings.notifications.event.permission.label"],
			description: m["settings.notifications.event.permission.description"],
		},
		agentTurn: {
			label: m["settings.notifications.event.agentTurn.label"],
			description: m["settings.notifications.event.agentTurn.description"],
		},
		scheduleRun: {
			label: m["settings.notifications.event.scheduleRun.label"],
			description: m["settings.notifications.event.scheduleRun.description"],
		},
		backgroundTask: {
			label: m["settings.notifications.event.backgroundTask.label"],
			description: m["settings.notifications.event.backgroundTask.description"],
		},
		chatTurn: {
			label: m["settings.notifications.event.chatTurn.label"],
			description: m["settings.notifications.event.chatTurn.description"],
		},
	};

	let view = $state<State | null>(null);
	let loadError = $state<string | null>(null);
	let support = $state<PushSupport>({ ok: true });
	let thisFingerprint = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state<{ kind: "ok" | "error"; text: string } | null>(null);

	const thisDevice = $derived(view?.devices.find((d) => d.fingerprint === thisFingerprint) ?? null);

	async function refresh() {
		const response = await fetch(`${base}/api/v2/push`);
		if (!response.ok) {
			loadError = await errorMessage(response, m["settings.notifications.load_failed"]());
			return;
		}
		const body = (await response.json()) as { data: State & { publicKey: string | null } };
		view = body.data;
		publicKey = body.data.publicKey;
		loadError = null;
	}

	let publicKey: string | null = null;

	async function readThisBrowser() {
		support = pushSupport();
		const subscription = await currentSubscription();
		thisFingerprint = subscription ? await fingerprintOf(subscription.endpoint) : null;
	}

	onMount(async () => {
		try {
			await refresh();
			await readThisBrowser();
		} catch {
			loadError = m["settings.notifications.load_failed"]();
		}
	});

	async function run(action: () => Promise<string | void>) {
		busy = true;
		notice = null;
		try {
			const text = await action();
			if (text) notice = { kind: "ok", text };
		} catch (err) {
			notice = {
				kind: "error",
				text:
					err instanceof PushClientError
						? err.message
						: m["settings.notifications.notice.generic_failure"](),
			};
		} finally {
			busy = false;
		}
	}

	const enable = () =>
		run(async () => {
			if (!publicKey)
				throw new PushClientError(m["settings.notifications.notice.not_set_up_here"]());
			await enableThisDevice(publicKey);
			await refresh();
			await readThisBrowser();
			return m["settings.notifications.notice.enabled"]();
		});

	async function removeDevice(device: Device) {
		await run(async () => {
			const own = device.fingerprint === thisFingerprint;
			const response = await fetch(`${base}/api/v2/push/${device.id}`, { method: "DELETE" });
			if (!response.ok && response.status !== 404) {
				throw new PushClientError(
					await errorMessage(response, m["settings.notifications.notice.remove_failed"]())
				);
			}
			if (own) (await currentSubscription())?.unsubscribe().catch(() => undefined);
			await refresh();
			await readThisBrowser();
			return own
				? m["settings.notifications.notice.disabled"]()
				: m["settings.notifications.notice.removed"]({ label: device.label });
		});
	}

	async function setEvent(event: PushEvent, on: boolean) {
		if (!view) return;
		const before = view.events[event];
		view.events[event] = on;
		const response = await fetch(`${base}/api/v2/push`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: { [event]: on } }),
		});
		if (!response.ok) {
			view.events[event] = before;
			notice = { kind: "error", text: m["settings.notifications.notice.save_failed"]() };
		}
	}

	const sendTest = () =>
		run(async () => {
			const response = await fetch(`${base}/api/v2/push/test`, { method: "POST" });
			if (!response.ok) {
				throw new PushClientError(
					await errorMessage(response, m["settings.notifications.notice.test_failed"]())
				);
			}
			const { data } = (await response.json()) as { data: { accepted: number } };
			return data.accepted > 0
				? m["settings.notifications.notice.sent"]({ count: data.accepted })
				: m["settings.notifications.notice.not_taken"]();
		});

	function when(iso: string | null): string {
		return iso ? formatDateTime(iso) : m["settings.notifications.devices.never"]();
	}
</script>

{#snippet code(text: string)}<code>{text}</code>{/snippet}

<div class="flex w-full flex-col gap-4" data-testid="notification-settings">
	{#if loadError}
		<p
			class="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm text-gray-500 shadow-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
		>
			{loadError}
		</p>
	{:else if !view}
		<p class="text-sm text-gray-500 dark:text-gray-400">{m["settings.notifications.loading"]()}</p>
	{:else if !view.configured}
		<div
			class="rounded-xl border border-gray-200 bg-white px-3 py-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
			data-testid="push-not-configured"
		>
			<h2 class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
				{m["settings.notifications.not_set_up.title"]()}
			</h2>
			<p class="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
				<Rich
					parts={m["settings.notifications.not_set_up.description"].parts({})}
					tags={{ configure: code, compose: code }}
				/>
			</p>
		</div>
	{:else}
		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="flex items-start justify-between gap-3 py-3">
				<div>
					<h2 class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
						{m["settings.notifications.this_device.title"]()}
					</h2>
					<p class="text-[12px] text-gray-500 dark:text-gray-400" data-testid="device-status">
						{#if !support.ok}
							{support.message}
						{:else if thisDevice}
							{m["settings.notifications.this_device.on"]()}
						{:else}
							{m["settings.notifications.this_device.off"]()}
						{/if}
					</p>
				</div>
				{#if support.ok && !thisDevice}
					<button
						type="button"
						class="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
						disabled={busy}
						onclick={enable}>{m["settings.notifications.turn_on"]()}</button
					>
				{:else if thisDevice}
					<button
						type="button"
						class="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
						disabled={busy}
						onclick={() => thisDevice && removeDevice(thisDevice)}
						>{m["settings.notifications.turn_off"]()}</button
					>
				{/if}
			</div>
		</div>

		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<h2 class="pt-3 text-[13px] font-medium text-gray-800 dark:text-gray-200">
				{m["settings.notifications.tell_me_when.title"]()}
			</h2>
			<p class="text-[12px] text-gray-500 dark:text-gray-400">
				{m["settings.notifications.tell_me_when.description"]()}
			</p>
			<div class="divide-y divide-gray-200 dark:divide-gray-700">
				{#each PUSH_EVENTS as event (event)}
					<div class="flex items-start justify-between gap-3 py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								{EVENT_LABELS[event].label()}
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								{EVENT_LABELS[event].description()}
							</p>
						</div>
						<Switch
							name={`push-${event}`}
							bind:checked={() => view?.events[event] ?? false, (v) => void setEvent(event, v)}
						/>
					</div>
				{/each}
			</div>
		</div>

		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="flex items-center justify-between gap-3 py-3">
				<h2 class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
					{m["settings.notifications.devices.title"]()}
				</h2>
				<button
					type="button"
					class="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-[13px] hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
					disabled={busy || view.devices.length === 0}
					onclick={sendTest}>{m["settings.notifications.devices.send_test"]()}</button
				>
			</div>
			{#if view.devices.length === 0}
				<p class="pb-3 text-[12px] text-gray-500 dark:text-gray-400">
					{m["settings.notifications.devices.none"]()}
				</p>
			{:else}
				<ul class="divide-y divide-gray-200 dark:divide-gray-700">
					{#each view.devices as device (device.id)}
						<li class="flex items-center justify-between gap-3 py-3" data-testid="push-device">
							<div class="min-w-0">
								<div class="truncate text-[13px] font-medium text-gray-800 dark:text-gray-200">
									{device.label}
									{#if device.fingerprint === thisFingerprint}
										<span
											class="ml-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-normal text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
											>{m["settings.notifications.devices.badge"]()}</span
										>
									{/if}
								</div>
								<p class="text-[12px] text-gray-500 dark:text-gray-400">
									{m["settings.notifications.devices.added"]({
										added: when(device.createdAt),
										notified: when(device.lastPushAt),
									})}
								</p>
							</div>
							<button
								type="button"
								class="shrink-0 text-[13px] text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
								disabled={busy}
								onclick={() => removeDevice(device)}
								>{m["settings.notifications.devices.remove"]()}</button
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if notice}
		<p
			role="status"
			class="text-[13px] {notice.kind === 'error'
				? 'text-red-600 dark:text-red-400'
				: 'text-gray-600 dark:text-gray-300'}"
		>
			{notice.text}
		</p>
	{/if}
</div>
