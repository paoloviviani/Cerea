<!--
	Pair a machine: run the agent, then confirm it here.

	`galopin` enrolls itself against this deployment's own OIDC issuer and
	dials out with that credential (spec §3-4) — there is nothing to paste
	and nothing to name here. It appears below as soon as it checks in, in `pending`; nothing
	is forwarded to it until this dialog's Confirm click flips it to
	`paired` — the fresh human approval a phished device-code approval alone
	never reaches (review C2). Reject is the same tombstoning action as
	revoking a paired machine (spec §4): the row becomes `revoked` and a
	reconnect under the same machine id is refused from then on.

	The pending list here is the same shared poll `CodeNavTree` shows in the
	sidebar (`codeDeviceList.svelte.ts`) — confirming from either place closes
	this dialog via `onpaired`.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import Rich from "$lib/i18n/Rich.svelte";
	import Modal from "$lib/components/Modal.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import IconLaptop from "~icons/carbon/laptop";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheck from "~icons/carbon/checkmark";
	import IconClose from "~icons/carbon/close";
	import { confirmDevice, revokeDevice, type CodeDeviceView } from "$lib/codeApi";
	import {
		codeDeviceList,
		refreshCodeDevices,
		dropCodeDevice,
		useCodeDevicePoll,
	} from "$lib/stores/codeDeviceList.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import {
		buildDockerCommand,
		buildEnrollCommand,
		cleanContainerName,
		DEFAULT_CONTAINER_NAME,
	} from "$lib/codeEnrollCommand";
	import { APP_VERSION } from "$lib/utils/appVersion";
	import SegmentedGroup from "$lib/components/settings/SegmentedGroup.svelte";
	import { defaultPolicyChoices } from "$lib/codeEnrollPolicy";
	import EnrollPolicyControls from "./EnrollPolicyControls.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		onclose: () => void;
		onpaired: (device: CodeDeviceView) => void;
	}

	let { onclose, onpaired }: Props = $props();

	const publicConfig = usePublicConfig();
	// The deployment's own origin plus the app's base path (`PublicConfig`'s
	// `origin`) — the machine dials out to `<this>/api/v2/code/machine`
	// (`X-Pystino-Machine-*` headers, spec §3) over WSS. Behind the Pystino
	// stack the chat is built with APP_BASE=/chat while PUBLIC_ORIGIN is the
	// bare origin, so without the base the printed command would send the
	// machine to the gateway.
	const origin = $derived(publicConfig.origin);
	// `CODE_GATEWAY_ORIGIN` unset (a deployment that never set it, or one
	// still on an older compose) falls back to the browser's own origin here,
	// not on the server (§12): the server has no better guess, and this one
	// is at least the address the person is looking at right now.
	const gatewayOrigin = $derived(page.data.codeGatewayOrigin || page.url.origin);
	let policyChoices = $state(defaultPolicyChoices());
	let installOpencode = $state(false);
	// Where the agent runs. Always opens on this computer: the choice is not
	// remembered, so a person who tried Docker once is not surprised by it later.
	let mode = $state<"native" | "docker">("native");
	const docker = $derived(mode === "docker");
	let containerName = $state(DEFAULT_CONTAINER_NAME);
	let keepPairing = $state(false);
	const modes = [
		{ value: "native", label: m["code.pair.mode_native"]() },
		{ value: "docker", label: m["code.pair.mode_docker"]() },
	];

	function chooseMode(value: string) {
		mode = value === "docker" ? "docker" : "native";
		// The image has no goose: a goose choice made on this computer must not
		// leak into the container's command (or come back unseen).
		if (mode === "docker") policyChoices.engine = "opencode";
	}

	const enrollOptions = $derived({
		origin,
		issuer: page.data.codeOidcIssuerUrl ?? "",
		gatewayOrigin,
		clientId: page.data.codeOidcClientId,
		flow: page.data.codeMachineFlow,
		...policyChoices,
	});
	const command = $derived(
		docker
			? buildDockerCommand({
					...enrollOptions,
					version: APP_VERSION,
					name: containerName,
					keepPairing,
				})
			: buildEnrollCommand({ ...enrollOptions, installOpencode })
	);
	// The long form, for a computer that already has an older galopin and installs nothing.
	const explicitCommand = $derived(
		buildEnrollCommand({ ...enrollOptions, installOpencode, explicit: true })
	);
	const downloads = [
		{ name: "galopin-linux-amd64", label: m["code.pair.platform_linux_amd64"]() },
		{ name: "galopin-linux-arm64", label: m["code.pair.platform_linux_arm64"]() },
		{ name: "galopin-darwin-arm64", label: m["code.pair.platform_darwin_arm64"]() },
		{ name: "galopin-darwin-amd64", label: m["code.pair.platform_darwin_amd64"]() },
		// i18n: literal (a file name)
		{ name: "SHA256SUMS", label: "SHA256SUMS" },
	];

	let busy = $state<string | null>(null);
	let failure = $state<string | null>(null);

	const pending = $derived(codeDeviceList.devices.filter((device) => device.status === "pending"));

	onMount(() => useCodeDevicePoll());

	async function confirm(device: CodeDeviceView) {
		busy = device.id;
		failure = null;
		try {
			await confirmDevice(device.id);
			await refreshCodeDevices();
			onpaired(device);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.pair.could_not_confirm"]();
		} finally {
			busy = null;
		}
	}

	async function reject(device: CodeDeviceView) {
		busy = device.id;
		failure = null;
		try {
			await revokeDevice(device.id);
			dropCodeDevice(device.id);
			void refreshCodeDevices();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.pair.could_not_reject"]();
		} finally {
			busy = null;
		}
	}
</script>

{#snippet inlineCode(text: string)}<code class="font-mono">{text}</code>{/snippet}
<Modal width="max-w-xl" closeButton labelledBy="pair-device-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconLaptop class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0 pr-8">
				<h2 id="pair-device-title" class={s.TITLE}>{m["code.pair.title"]()}</h2>
				<p class="{s.SUBTITLE} break-words">
					{m["code.pair.subtitle"]()}
				</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					{failure}
				</p>
			</div>
		{/if}

		<div class="mb-4">
			<SegmentedGroup
				label={m["code.pair.mode_label"]()}
				options={modes}
				value={mode}
				onchange={chooseMode}
			/>
		</div>

		<p class="{s.LABEL} mb-2">
			{docker ? m["code.pair.docker_label"]() : m["code.pair.install_label"]()}
		</p>
		<div class="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface p-3">
			<pre
				class="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap text-ink"
				data-testid="galopin-enroll-command">{command}</pre>
			<CopyToClipBoardBtn
				classNames="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
				value={command}
			/>
		</div>
		{#if !docker}
			<details class="mb-3 text-xs text-ink-muted" data-testid="pair-older-galopin">
				<summary class="cursor-pointer">{m["code.pair.older_galopin"]()}</summary>
				<p class="mt-2">{m["code.pair.older_galopin_note"]()}</p>
				<div class="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface p-3">
					<pre
						class="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap text-ink"
						data-testid="galopin-enroll-command-explicit">{explicitCommand}</pre>
					<CopyToClipBoardBtn
						classNames="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
						value={explicitCommand}
					/>
				</div>
			</details>
		{/if}
		<p class="mb-4 text-xs text-ink-muted" data-testid="pair-explain">
			{#if docker}
				{m["code.pair.docker_explain"]()}
			{:else}
				<Rich parts={m["code.pair.explain"].parts()} tags={{ code: inlineCode }} />
			{/if}
		</p>
		{#if docker}
			<div class="mb-4 text-xs text-ink-muted" data-testid="pair-docker-options">
				<label class="mb-3 flex flex-col gap-1">
					<span class="font-medium text-ink">{m["code.pair.docker_name_label"]()}</span>
					<input
						type="text"
						class="w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-blue-600 focus:outline-hidden sm:w-64"
						data-testid="pair-docker-name"
						autocomplete="off"
						spellcheck="false"
						maxlength="63"
						placeholder={DEFAULT_CONTAINER_NAME}
						bind:value={containerName}
						onblur={() => (containerName = cleanContainerName(containerName))}
					/>
					<span>{m["code.pair.docker_name_text"]()}</span>
				</label>
				<label class="mb-1 flex items-start gap-2">
					<input
						type="checkbox"
						class="mt-0.5"
						data-testid="pair-docker-keep"
						bind:checked={keepPairing}
					/>
					<span>
						<span class="font-medium text-ink">{m["code.pair.docker_keep_label"]()}</span>
						{m["code.pair.docker_keep_text"]()}
					</span>
				</label>
				{#if keepPairing}
					<p class="mb-1 ml-6" data-testid="pair-docker-keep-note">
						<Rich parts={m["code.pair.docker_keep_note"].parts()} tags={{ code: inlineCode }} />
					</p>
				{/if}
				<p class="mt-3" data-testid="pair-docker-paths">
					<Rich parts={m["code.pair.docker_paths"].parts()} tags={{ code: inlineCode }} />
				</p>
			</div>
		{:else}
			<details class="mb-4 text-xs text-ink-muted" data-testid="pair-download">
				<summary class="cursor-pointer">{m["code.pair.download"]()}</summary>
				<ul class="mt-2 flex flex-col gap-1 pl-2">
					{#each downloads as download (download.name)}
						<li>
							<a
								class="text-blue-600 hover:underline dark:text-blue-400"
								href="{base}/galopin/{download.name}">{download.label}</a
							>
							<span class="font-mono">({download.name})</span>
						</li>
					{/each}
				</ul>
				<p class="mt-2">
					<Rich parts={m["code.pair.build"].parts()} tags={{ code: inlineCode }} />
				</p>
			</details>
		{/if}

		<EnrollPolicyControls bind:choices={policyChoices} bind:installOpencode {docker} />

		<p class="{s.LABEL} mt-6">{m["code.pair.waiting"]()}</p>
		{#if pending.length === 0}
			<p class="mt-1 text-xs text-ink-muted">{m["code.pair.none_yet"]()}</p>
		{:else}
			<ul class="mt-2 flex flex-col gap-2">
				{#each pending as device (device.id)}
					<li class="flex items-center gap-2 rounded-lg border border-line bg-surface p-2">
						<IconLaptop class="size-4 shrink-0 text-ink-muted" />
						<span class="min-w-0 flex-1 truncate text-sm text-ink">{device.name}</span>
						<button
							type="button"
							class="flex h-7 items-center gap-1 rounded-lg bg-blue-600 px-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
							disabled={busy === device.id}
							onclick={() => void confirm(device)}
						>
							<IconCheck class="size-3.5" />
							{m["code.pair.confirm"]()}
						</button>
						<button
							type="button"
							class="flex h-7 items-center gap-1 rounded-lg border border-line px-2 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
							disabled={busy === device.id}
							onclick={() => void reject(device)}
						>
							<IconClose class="size-3.5" />
							{m["code.pair.reject"]()}
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		<div class={s.SHEET_FOOTER}>
			<button type="button" onclick={onclose} class={s.SECONDARY}>{m["code.pair.close"]()}</button>
		</div>
	</div>
</Modal>
