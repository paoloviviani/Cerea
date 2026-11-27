<!--
	A paired computer's upgrade, in the Agents panel (C159). Two parts, both about galopin's
	version on that computer:

	- the outdated notice, with the way to upgrade that fits it. The **Upgrade** button appears
	  only when the computer is online and reported `agent.upgrade.inPlace: true` (galopin runs
	  as its systemd user unit and the owner has not opted out); every other case keeps the
	  instructions that fit it (`upgradeInstructions`, galopinUpgrade.ts); the desktop app's galopin
	  gets a link to the app's releases and no command, as the installer would add a second galopin;
	- the state of an upgrade started from here: Upgrading, Updated to vX, or did not complete.

	Cerea lists only a user's own computers, so whoever sees the button is the owner; the
	endpoint refuses anyone else anyway.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import Modal from "$lib/components/Modal.svelte";
	import Rich from "$lib/i18n/Rich.svelte";
	import * as s from "$lib/components/overlay/styles";
	import { startUpgrade } from "$lib/codeApi";
	import { refreshCodeDevices } from "$lib/stores/codeDeviceList.svelte";
	import type { CodeDeviceView } from "$lib/server/codeDevices";
	import { GALOPIN_IMAGE } from "$lib/codeEnrollCommand";
	import {
		DESKTOP_RELEASES_URL,
		UPGRADE_LOG_HINT,
		buildUpgradeCommand,
		galopinNeedsUpgrade,
		galopinUnsupported,
		upgradeInstructions,
	} from "$lib/galopinUpgrade";
	import { APP_VERSION, GALOPIN_LAST_CHANGED, MIN_SUPPORTED_GALOPIN } from "$lib/utils/appVersion";

	interface Props {
		device: CodeDeviceView;
		origin: string;
	}

	let { device, origin }: Props = $props();

	const outdated = $derived(galopinNeedsUpgrade(device.agentVersion, GALOPIN_LAST_CHANGED));
	const required = $derived(galopinUnsupported(device.agentVersion, MIN_SUPPORTED_GALOPIN));
	const how = $derived(upgradeInstructions(device));
	const upgradeCommand = $derived(buildUpgradeCommand(origin));
	const dockerPull = $derived(`docker pull ${GALOPIN_IMAGE}:${APP_VERSION}`);
	const run = $derived(device.upgrade);
	// While one is running there is nothing to start again, and the instructions would only invite
	// a second, concurrent upgrade.
	const running = $derived(run?.state === "running");

	let confirming = $state(false);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function start() {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await startUpgrade(device.id);
			confirming = false;
			await refreshCodeDevices();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.nav.upgrade_start_failed"]();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet releasesLink(text: string)}<a
		class="text-accent hover:underline"
		href={DESKTOP_RELEASES_URL}
		target="_blank"
		rel="noopener noreferrer"
		data-testid="device-upgrade-desktop-releases">{text}</a
	>{/snippet}

{#if run}
	<div
		class="mb-1.5 ml-7 rounded-lg border border-line bg-sunken p-2 text-xs text-ink-muted"
		data-testid="device-upgrade-state"
		data-state={run.state}
		role="status"
	>
		{#if run.state === "running"}
			<p class="font-medium text-ink">{m["code.nav.upgrade_running"]({ name: device.name })}</p>
		{:else if run.state === "done"}
			<p class="font-medium text-ink">
				{m["code.nav.upgrade_done"]({ version: run.version ?? run.targetVersion })}
			</p>
		{:else}
			<p class="font-medium text-ink">{m["code.nav.upgrade_failed"]()}</p>
			<p class="mt-1">
				{m["code.nav.upgrade_failed_log"]()}
				<code class="font-mono text-[.65rem] text-ink">{UPGRADE_LOG_HINT}</code>
			</p>
		{/if}
	</div>
{/if}

{#if outdated && !running}
	<div
		class="mb-1.5 ml-7 rounded-lg border p-2 text-xs text-ink-muted {required
			? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
			: 'border-line bg-sunken'}"
		data-testid="device-upgrade"
		data-severity={required ? "required" : "available"}
		data-how={how}
	>
		<p class="mb-1.5 font-medium text-ink">
			{required
				? m["code.nav.upgrade_galopin_required"]({ version: device.agentVersion ?? "" })
				: m["code.nav.upgrade_galopin"]({ version: device.agentVersion ?? "" })}
		</p>
		{#if how === "button"}
			<button
				type="button"
				class={s.PRIMARY}
				data-testid="device-upgrade-button"
				onclick={() => {
					failure = null;
					confirming = true;
				}}
			>
				{m["code.nav.upgrade_button"]()}
			</button>
		{:else}
			{#if how === "desktop_app"}
				<p class="mb-1.5" data-testid="device-upgrade-desktop-app">
					<Rich parts={m["code.nav.upgrade_desktop_app"].parts()} tags={{ link: releasesLink }} />
				</p>
			{:else if how === "mac_app"}
				<p class="mb-1.5" data-testid="device-upgrade-mac-app">
					{m["code.nav.upgrade_mac_app"]()}
				</p>
			{:else if how === "docker"}
				<p class="mb-1.5" data-testid="device-upgrade-docker">
					{m["code.nav.upgrade_docker"]()}
				</p>
			{:else if how === "launchd"}
				<p class="mb-1.5" data-testid="device-upgrade-launchd">
					{m["code.nav.upgrade_launchd"]()}
				</p>
			{:else if how === "foreground"}
				<p class="mb-1.5" data-testid="device-upgrade-foreground">
					{m["code.nav.upgrade_foreground"]()}
				</p>
			{/if}
			{#if how === "docker"}
				<div class="flex items-center gap-2 rounded-md border border-line bg-surface p-2">
					<pre
						class="min-w-0 flex-1 overflow-x-auto font-mono text-[.65rem] whitespace-pre text-ink">{dockerPull}</pre>
					<CopyToClipBoardBtn
						classNames="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
						value={dockerPull}
					/>
				</div>
			{:else if how !== "mac_app" && how !== "desktop_app"}
				<div class="flex items-center gap-2 rounded-md border border-line bg-surface p-2">
					<pre
						class="min-w-0 flex-1 overflow-x-auto font-mono text-[.65rem] whitespace-pre text-ink">{upgradeCommand}</pre>
					<CopyToClipBoardBtn
						classNames="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
						value={upgradeCommand}
					/>
				</div>
			{/if}
		{/if}
	</div>
{/if}

{#if confirming}
	<Modal
		width="max-w-md"
		closeButton
		labelledBy="device-upgrade-title"
		onclose={() => (confirming = false)}
	>
		<div class="p-6" data-testid="device-upgrade-confirm">
			<h2 id="device-upgrade-title" class={s.TITLE}>{m["code.nav.upgrade_confirm_title"]()}</h2>
			<p class="{s.SUBTITLE} mb-4">{device.name}</p>
			{#if failure}
				<div class="{s.ERROR} mb-4" role="alert">
					<p>{failure}</p>
				</div>
			{/if}
			<p class="text-sm text-ink" data-testid="device-upgrade-versions">
				{m["code.nav.upgrade_confirm_versions"]({
					from: device.agentVersion ?? "",
					to: APP_VERSION,
				})}
			</p>
			<p class="mt-2 text-sm text-ink-muted">{m["code.nav.upgrade_confirm_message"]()}</p>
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (confirming = false)}
					class={s.SECONDARY}
					disabled={busy}
				>
					{m["code.common.cancel"]()}
				</button>
				<button
					type="button"
					class={s.PRIMARY}
					data-testid="device-upgrade-confirm-button"
					disabled={busy}
					onclick={() => void start()}
				>
					{busy ? m["code.nav.upgrade_busy"]() : m["code.nav.upgrade_button"]()}
				</button>
			</div>
		</div>
	</Modal>
{/if}
