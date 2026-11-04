<!--
	The card a conversation keeps for a coding-agent session its turn started or
	prompted (ADR 0106 §4). It renders from the stored update alone (title,
	"machine › workspace", the ids), so it survives a reload and shows with no
	machine at all; the live state comes from the /code data the client already
	keeps (`codeDeviceList` for the machine, `codeTreeCache` for its sessions) —
	no endpoint of its own.

	- A stale sign-in shows the compact sign-in card instead of the state: the
	  /code endpoints refuse everything else, and the panel drops what it held.
	- An offline machine shows one plain line.
	- Without /code for this user (`codeAgentsEnabled`) the card is the record
	  only: no state, no link to a page that would 404.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";
	import CodeReauthCard from "$lib/components/code/CodeReauthCard.svelte";
	import { loadCodeStatus } from "$lib/codeApi";
	import { codeDeviceList, useCodeDevicePoll } from "$lib/stores/codeDeviceList.svelte";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import { codeTreeCache, isCodeTreeFresh, loadDeviceTree } from "$lib/stores/codeTreeCache.svelte";
	import type { MessageAgentSessionUpdate } from "$lib/types/MessageUpdate";
	import IconCode from "~icons/carbon/code";
	import IconHelp from "~icons/carbon/help";
	import IconRenew from "~icons/carbon/renew";
	import IconWarning from "~icons/carbon/warning";
	import IconLaunch from "~icons/carbon/launch";

	interface Props {
		update: MessageAgentSessionUpdate;
	}

	let { update }: Props = $props();

	const POLL_MS = 8000;

	let live = $derived(page.data.codeAgentsEnabled === true);
	let device = $derived(codeDeviceList.devices.find((d) => d.id === update.deviceId));
	let tree = $derived(codeTreeCache.trees[update.deviceId]);
	let session = $derived(tree?.agents.find((a) => a.id === update.sessionId));

	type State = "checking" | "offline" | "missing" | "needs-you" | "working" | "error" | "idle";

	let state = $derived<State>(
		!device
			? codeDeviceList.loading
				? "checking"
				: "offline"
			: !device.online || tree?.off
				? "offline"
				: !tree
					? "checking"
					: !session
						? "missing"
						: session.state === "waiting-permission"
							? "needs-you"
							: session.state === "running"
								? "working"
								: session.state === "error"
									? "error"
									: "idle"
	);

	const TONES: Record<State, keyof typeof s.PILL_TONES> = {
		checking: "neutral",
		offline: "neutral",
		missing: "neutral",
		"needs-you": "warn",
		working: "busy",
		error: "bad",
		idle: "neutral",
	};
	const LABELS: Record<State, () => string> = {
		checking: m["chat.agent_session.state_checking"],
		offline: m["chat.agent_session.state_offline"],
		missing: m["chat.agent_session.state_missing"],
		"needs-you": m["chat.agent_session.state_needs_you"],
		working: m["chat.agent_session.state_working"],
		error: m["chat.agent_session.state_error"],
		idle: m["chat.agent_session.state_idle"],
	};

	let href = $derived(
		`${base}/code?device=${encodeURIComponent(update.deviceId)}&ws=${encodeURIComponent(update.workspaceId)}&agent=${encodeURIComponent(update.sessionId)}`
	);
	let title = $derived(update.title);
	let route = $derived(
		(update.action === "started"
			? m["chat.agent_session.route_started"]
			: m["chat.agent_session.route_prompted"])({
			device: update.labels.device,
			workspace: update.labels.workspace,
		})
	);

	// Live data: the machine list (the shared, ref-counted poll, so many cards
	// cost one interval), then this machine's sessions once it is known to be
	// online, then a re-read while the session is moving. An offline machine is
	// never asked.
	function read() {
		if (!live || codeReauth.required || !device?.online) return;
		if (!isCodeTreeFresh(update.deviceId)) void loadDeviceTree(update.deviceId);
	}
	onMount(() => {
		if (!live) return;
		void loadCodeStatus();
		const stopPoll = useCodeDevicePoll();
		const timer = setInterval(() => {
			if (state === "working" || state === "needs-you") read();
		}, POLL_MS);
		return () => {
			stopPoll();
			clearInterval(timer);
		};
	});
	// First read, and the machine coming online after the card mounted.
	$effect(() => {
		if (device?.online && !tree) read();
	});
</script>

<section
	class="{s.card(false)} max-w-xl min-w-0 px-3.5 py-3"
	aria-label={m["chat.agent_session.label"]({ title })}
	data-testid="agent-session-card"
	data-action={update.action}
	data-state={live && !codeReauth.required ? state : undefined}
>
	<div class="flex min-w-0 items-start gap-2.5">
		<IconCode class="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-semibold text-ink" {title}>
				{title}
			</p>
			<p class="truncate text-xs text-ink-muted" title={route} data-testid="agent-session-route">
				{route}
			</p>
		</div>
		{#if live && !codeReauth.required}
			<span
				class="{s.PILL} {s.PILL_TONES[TONES[state]]}"
				role="status"
				data-testid="agent-session-state"
			>
				{#if state === "working"}
					<IconRenew class="size-3.5 animate-spin" aria-hidden="true" />
				{:else if state === "needs-you"}
					<IconHelp class="size-3.5" aria-hidden="true" />
				{:else if state === "error"}
					<IconWarning class="size-3.5" aria-hidden="true" />
				{:else}
					<span
						class="size-1.5 rounded-full {state === 'idle' ? 'bg-ok' : 'bg-ink-faint'} ml-0.5"
						aria-hidden="true"
					></span>
				{/if}
				{LABELS[state]()}
			</span>
		{/if}
	</div>

	{#if live && codeReauth.required}
		<div class="mt-2">
			<CodeReauthCard compact />
		</div>
	{:else if live && state === "offline"}
		<p class="mt-2 text-xs text-ink-muted" data-testid="agent-session-offline">
			{m["chat.agent_session.offline_line"]({ device: update.labels.device })}
		</p>
	{/if}

	{#if live && !codeReauth.required}
		<div class="mt-2.5">
			<a
				{href}
				class={s.CARD_ACTION + " w-fit"}
				aria-label={m["chat.agent_session.open_label"]({ title })}
			>
				<IconLaunch class="size-3.5" aria-hidden="true" />
				{m["chat.agent_session.open"]()}
			</a>
		</div>
	{/if}
</section>
