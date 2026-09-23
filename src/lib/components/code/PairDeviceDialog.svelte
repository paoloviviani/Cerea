<!--
	Start a pairing, and finish one.

	Two steps in one dialog rather than two screens: naming the machine, then
	handing it the setup script. The machine pairs itself — the script enrolls
	it with the deployment's identity provider and POSTs the pairing offer to
	Cerea (`enroll pair`) under the enrollment's own bearer, so there is no
	link to paste. While the dialog is open it watches the device list and
	closes the moment a paired machine it has not seen checks in; the paste
	flow (`paseo daemon pair` + the claim endpoint) stays available server-side
	for a machine that cannot reach this origin, and the pending row the first
	step creates keeps its manual code visible in the tree for exactly that
	fallback.

	The commands name this deployment from its own public config (`PUBLIC_ORIGIN`,
	the same origin the gateway and the chat share — the relay answers at /ws on
	it), never a hardcoded host, and carry the machine name the person typed as
	the script's `--name`.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { page } from "$app/state";
	import Modal from "$lib/components/Modal.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import IconLaptop from "~icons/carbon/laptop";
	import IconWarning from "~icons/carbon/warning-filled";
	import { listDevices, startPairing, type CodeDeviceView } from "$lib/codeApi";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		onclose: () => void;
		onpaired: (device: CodeDeviceView) => void;
		/** Re-enrolling an already-paired device whose enrollment expired or
		 * was revoked, rather than pairing a new machine: the naming step is
		 * skipped (the row already has a name), and the watcher below tracks
		 * this device's own `pairedAt` advancing instead of watching for a
		 * new device id — an id that already exists in the paired set would
		 * never look "new". */
		reenroll?: { deviceId: string; name: string };
	}

	let { onclose, onpaired, reenroll }: Props = $props();

	type Step = "name" | "wait";
	// The one-time initial read, not a live binding: `reenroll` never changes
	// after this dialog mounts (it names which flow opened it), so `step`
	// and `name` are seeded from it once and then are this component's own
	// mutable state — `untrack` says so explicitly rather than leaving the
	// compiler to guess.
	let step = $state<Step>(untrack(() => (reenroll ? "wait" : "name")));
	let name = $state(untrack(() => reenroll?.name ?? ""));
	let busy = $state(false);
	let failure = $state<string | null>(null);

	const publicConfig = usePublicConfig();

	// The deployment's own origin — the same one the gateway, the chat and the
	// relay share. The panel builds its header link from PUBLIC_ORIGIN the same
	// way; the page origin is only the fallback a misconfigured deployment gets.
	const origin = $derived(publicConfig.PUBLIC_ORIGIN || page.url.origin);

	// The relay lives at the deployment origin's /ws path on the same host (no
	// dedicated port), so `--relay` is that origin's host:port — the script
	// defaults TLS the way the SDK does (on at 443, off elsewhere), which is
	// why the port is spelled out rather than left to the CLI.
	const relayHost = $derived.by(() => {
		const url = new URL(origin);
		return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
	});

	// The typed name rides into the script's --name (it sets the machine's
	// display name in the panel); quotes are escaped because the value is
	// interpolated into a double-quoted shell argument.
	const setupCommand = $derived.by(() => {
		const quoted = name.trim().replace(/"/g, '\\"');
		return `./setup-agent.sh --relay ${relayHost} --gateway ${origin} --issuer ${origin}/authelia --name "${quoted}" --yes`;
	});
	const commands = $derived([
		"git clone https://github.com/paoloviviani/Pystino.git",
		"cd Pystino/deploy/opencode",
		setupCommand,
	]);

	// The watcher: while the dialog is open, poll the device list every 3s and
	// finish the moment a paired machine that was not there before shows up.
	// The baseline is the paired set read the moment the instructions appear —
	// the machine cannot have the commands yet, so anything paired after that
	// is this pairing. If that read failed the baseline falls back to the
	// watcher's first successful poll (a machine that pairs faster than the
	// first poll would then be taken as pre-existing; the person closes the
	// dialog by hand — never a wrong "paired"). No interval when the dialog is
	// closed: every exit path — button, Escape, backdrop, unmount — clears the
	// flag the loop checks.
	let watching = $state(false);
	const POLL_MS = 3000;
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	async function watchForPairing(initial: Set<string> | null) {
		let seen = initial;
		while (watching) {
			await sleep(POLL_MS);
			if (!watching) return;
			try {
				const { devices } = await listDevices();
				const paired = devices.filter((device) => device.status === "paired");
				if (!seen) {
					seen = new Set(paired.map((device) => device.id));
					continue;
				}
				const newcomer = paired.find((device) => !seen?.has(device.id));
				if (newcomer) {
					watching = false;
					onpaired(newcomer);
					onclose();
					return;
				}
			} catch {
				// a failed poll is a missed beat, not a failed pairing
			}
		}
	}

	/**
	 * The re-enroll watcher: the device already exists in the paired set, so
	 * "a new id appeared" (the plain pairing watcher's signal) can never
	 * fire for it. Instead it tracks this one row's own `pairedAt` — the
	 * machine endpoint (`enroll/machine`) bumps it on every successful
	 * (re-)pairing, new row or not — against a baseline read on the first
	 * poll, the same discipline `watchForPairing` uses for its baseline.
	 */
	async function watchForReenroll(deviceId: string) {
		let baseline: number | null = null;
		while (watching) {
			await sleep(POLL_MS);
			if (!watching) return;
			try {
				const { devices } = await listDevices();
				const device = devices.find((d) => d.id === deviceId);
				const pairedAt = device?.pairedAt ? new Date(device.pairedAt).getTime() : 0;
				if (baseline === null) {
					baseline = pairedAt;
					continue;
				}
				if (device?.status === "paired" && pairedAt > baseline) {
					watching = false;
					onpaired(device);
					onclose();
					return;
				}
			} catch {
				// a failed poll is a missed beat, not a failed pairing
			}
		}
	}

	function stopWatching() {
		watching = false;
	}

	$effect(() => {
		return stopWatching;
	});

	// Re-enroll skips the naming step entirely, so nothing else starts the
	// watcher for it — kick it off the moment the dialog mounts with one to
	// re-enroll.
	$effect(() => {
		if (!reenroll) return;
		watching = true;
		void watchForReenroll(reenroll.deviceId);
	});

	async function handleStart() {
		if (!name.trim() || busy) return;
		busy = true;
		failure = null;
		try {
			// The pending row is kept even though the machine pairs itself: it
			// is the manual fallback's visible code in the tree while the
			// script runs, and expires with the row when unused.
			await startPairing(name.trim());
			// The baseline read is part of the step switch: whatever is paired
			// NOW predates this pairing, because the instructions have not
			// been shown yet.
			let baseline: Set<string> | null = null;
			try {
				baseline = new Set(
					(await listDevices()).devices
						.filter((device) => device.status === "paired")
						.map((device) => device.id)
				);
			} catch {
				// the watcher falls back to its own first poll for the baseline
			}
			step = "wait";
			watching = true;
			void watchForPairing(baseline);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start pairing.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="pair-device-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconLaptop class="size-5 text-blue-600" />
			</div>
			<!-- min-w-0 + pr-8: the same phone discipline the agent dialog
			     follows — the column shrinks below its content's min-content
			     and stays clear of the close button at top-right. -->
			<div class="min-w-0 pr-8">
				<h2 id="pair-device-title" class={s.TITLE}>
					{reenroll ? "Re-enroll this machine" : "Pair a device"}
				</h2>
				<p class="{s.SUBTITLE} break-words">
					{#if reenroll}
						Run the setup again on {reenroll.name}; this closes itself once it checks back in.
					{:else}
						{step === "name"
							? "Name the machine your coding agents run on."
							: `Set the machine up, then wait for it to check in.`}
					{/if}
				</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Pairing failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{/if}

		{#if step === "name"}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void handleStart();
				}}
			>
				<label class={s.LABEL} for="pair-device-name">Device name</label>
				<input
					id="pair-device-name"
					class={s.INPUT}
					placeholder="my laptop"
					maxlength={64}
					bind:value={name}
					disabled={busy}
				/>
				<p class={s.HINT}>Something you will recognise in the device list.</p>
				<div class="mt-4 flex flex-wrap justify-end gap-2">
					<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
						Cancel
					</button>
					<button type="submit" class={s.PRIMARY} disabled={!name.trim() || busy}>
						{busy ? "Starting…" : "Start pairing"}
					</button>
				</div>
			</form>
		{:else}
			<div class="mb-4 flex items-center gap-2 rounded-lg bg-sunken p-4">
				<p class="min-w-0 flex-1 text-xs text-ink-muted">
					Run this on <span class="font-medium text-ink">{name.trim()}</span>, then leave this open
					— the dialog closes by itself when the machine checks in.
				</p>
				<CopyToClipBoardBtn
					classNames="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
					value={commands.join("\n")}
				/>
			</div>
			<!-- break-all: the commands are the one thing here that must never
			     clip — hosts and paths are unbreakable words, and the operator's
			     phone is 264px wide. -->
			<div class="rounded-lg border border-line bg-surface p-3">
				{#each commands as command (command)}
					<p class="font-mono text-xs break-all text-ink">{command}</p>
				{/each}
			</div>
			<p class={s.HINT}>
				The script installs the daemon, enrolls the machine with your account and pairs it back
				here. The relay and gateway addresses are this deployment's own.
			</p>
			<div class="mt-4 flex items-center justify-between gap-2">
				<p class="min-w-0 flex-1 truncate text-xs text-ink-muted" aria-live="polite">
					{#if watching}
						<span class="animate-pulse">Waiting for {name.trim()} to check in</span>
					{/if}
				</p>
				<button type="button" onclick={onclose} class={s.SECONDARY}>Close</button>
			</div>
		{/if}
	</div>
</Modal>
