<!--
	A fork handoff (parity plan §4.2(a)): a new session, on this machine or
	another of the caller's own paired ones, seeded with a prompt and —
	optionally — the source transcript up to the message the person hit
	"Hand off…" on. In the style of `AgentDialog.svelte`; see it for the
	phone-sized-first and sticky-footer notes, which apply here unchanged.

	The route (`POST v1/agents/:id/handoff`) does the actual work — this
	dialog only collects the target and prefills it from the source, then
	navigates to whatever session comes back.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import IconFork from "~icons/carbon/fork";
	import IconWarning from "~icons/carbon/warning-filled";
	import { handoffAgent, listProviderModels, listProviderModes, listWorkspaces } from "$lib/codeApi";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import type {
		CodeAgentSession,
		CodeProviderMode,
		CodeProviderModel,
		CodeWorkspace,
	} from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** The source session's own device, workspace, provider, mode and
		 * model — this dialog's prefill, per the source device by default. */
		deviceId: string;
		agentId: string;
		agentTitle: string;
		workspace: CodeWorkspace;
		provider: string;
		modeId: string | null;
		modelId: string | null;
		/** The machine's own id for the message "Hand off…" was clicked on
		 * (`Message.machineMessageId`) — the "carry up to here" boundary.
		 * Undefined carries the whole transcript instead (still curated,
		 * never truncated at the click point). */
		uptoMessageId?: string;
		onclose: () => void;
		onhandoff: (result: { agent: CodeAgentSession; deviceId: string }) => void;
	}

	let {
		deviceId,
		agentId,
		agentTitle,
		workspace,
		provider,
		modeId,
		modelId,
		uptoMessageId,
		onclose,
		onhandoff,
	}: Props = $props();

	// The only valid targets (spec): the caller's own devices, paired and
	// currently online — `codeDeviceList` is the shared poll every other
	// device-aware surface in the panel already reads from.
	let targetDevices = $derived(
		codeDeviceList.devices.filter((d) => d.status === "paired" && d.online !== false)
	);

	// A one-time snapshot of the source's own device/workspace/mode/model, not
	// a live mirror of the props: this dialog mounts fresh each time it opens
	// (`{#if handoffFor}` in AgentView), so there is nothing to re-sync later
	// — `untrack` says so explicitly, rather than leaving it to look like a
	// missed `$derived`.
	let targetDevice = $state(untrack(() => deviceId));
	let workspaces = $state<CodeWorkspace[]>(untrack(() => [workspace]));
	let targetWorkspaceId = $state(untrack(() => workspace.id));
	let modes = $state<CodeProviderMode[]>([]);
	let models = $state<CodeProviderModel[]>([]);
	let targetModeId = $state(untrack(() => modeId ?? ""));
	let targetModelId = $state(untrack(() => modelId ?? ""));
	let carry = $state(true);
	let prompt = $state("");
	let listsBusy = $state(false);
	let listsFailure = $state<string | null>(null);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	// The target's own workspaces/modes/models — refetched whenever the
	// device changes, same as `AgentComposer`'s pills. Tokened against races:
	// a slow answer for a device the person already switched away from must
	// never clobber what the fast answer for the new one just set.
	let listsToken = 0;
	async function loadTargetLists(nextDevice: string) {
		const token = ++listsToken;
		listsBusy = true;
		listsFailure = null;
		try {
			const [wsResult, modesResult, modelsResult] = await Promise.all([
				listWorkspaces(nextDevice),
				listProviderModes(nextDevice, provider),
				listProviderModels(nextDevice, provider),
			]);
			if (token !== listsToken) return;
			workspaces = wsResult.workspaces;
			modes = modesResult.modes;
			models = modelsResult.models;
			targetWorkspaceId =
				nextDevice === deviceId
					? workspace.id
					: (workspaces.find((w) => w.id === targetWorkspaceId)?.id ?? workspaces[0]?.id ?? "");
			if (!modes.some((mode) => mode.id === targetModeId)) targetModeId = modes[0]?.id ?? "";
			if (targetModelId && !models.some((model) => model.id === targetModelId)) targetModelId = "";
		} catch (err) {
			if (token === listsToken) {
				listsFailure =
					err instanceof Error ? err.message : "Could not read that machine's workspaces.";
			}
		} finally {
			if (token === listsToken) listsBusy = false;
		}
	}

	onMount(() => {
		void loadTargetLists(deviceId);
	});

	async function handleSubmit() {
		if (busy || !prompt.trim()) return;
		busy = true;
		failure = null;
		try {
			const result = await handoffAgent(deviceId, agentId, {
				prompt: prompt.trim(),
				carry,
				...(targetDevice !== deviceId ? { targetDevice } : {}),
				...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
				...(targetModeId ? { modeId: targetModeId } : {}),
				...(targetModelId ? { modelId: targetModelId } : {}),
				...(carry && uptoMessageId ? { uptoMessageId } : {}),
			});
			onhandoff(result);
			onclose();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not hand off this session.";
		} finally {
			busy = false;
		}
	}
</script>

<Modal width="max-w-md" closeButton labelledBy="handoff-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconFork class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0 pr-8">
				<h2 id="handoff-title" class={s.TITLE}>Hand off…</h2>
				<p class="{s.SUBTITLE} break-words">From {agentTitle}</p>
			</div>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Handoff failed
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{:else if listsFailure}
			<div class="{s.ERROR} mb-4">
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					{listsFailure}
				</p>
			</div>
		{/if}

		<form
			onsubmit={(e) => {
				e.preventDefault();
				void handleSubmit();
			}}
		>
			<label class={s.LABEL} for="handoff-device">Device</label>
			<select
				id="handoff-device"
				class={s.INPUT}
				style="font-size: 16px;"
				bind:value={targetDevice}
				onchange={() => void loadTargetLists(targetDevice)}
				disabled={busy}
			>
				{#each targetDevices as device (device.id)}
					<option value={device.id}
						>{device.name}{device.id === deviceId ? " (this machine)" : ""}</option
					>
				{/each}
			</select>

			<label class="{s.LABEL} mt-4" for="handoff-workspace">Workspace</label>
			{#if listsBusy && workspaces.length === 0}
				<p class="text-sm text-ink-muted">Reading that machine's workspaces…</p>
			{:else}
				<select
					id="handoff-workspace"
					class={s.INPUT}
					style="font-size: 16px;"
					bind:value={targetWorkspaceId}
					disabled={busy || workspaces.length === 0}
				>
					{#each workspaces as ws (ws.id)}
						<option value={ws.id}>{ws.name}</option>
					{/each}
				</select>
			{/if}

			<label class="{s.LABEL} mt-4" for="handoff-mode">Mode</label>
			<select
				id="handoff-mode"
				class={s.INPUT}
				style="font-size: 16px;"
				bind:value={targetModeId}
				disabled={busy || modes.length === 0}
			>
				{#if modes.length === 0}
					<option value="">Daemon default</option>
				{/if}
				{#each modes as mode (mode.id)}
					<option value={mode.id}>{mode.label}</option>
				{/each}
			</select>

			<label class="{s.LABEL} mt-4" for="handoff-model">Model</label>
			<select
				id="handoff-model"
				class={s.INPUT}
				style="font-size: 16px;"
				bind:value={targetModelId}
				disabled={busy}
			>
				<option value="">Daemon default</option>
				{#each models as model (model.id)}
					<option value={model.id}>{model.label}</option>
				{/each}
			</select>

			<label class="mt-4 flex items-center gap-2 text-sm text-ink">
				<input type="checkbox" bind:checked={carry} disabled={busy} />
				Carry the conversation up to here
			</label>
			<p class={s.HINT}>
				{carry
					? "The new agent's first message carries a summary of this conversation as an attachment."
					: "The new agent starts cold, with only the prompt below."}
			</p>

			<label class="{s.LABEL} mt-4" for="handoff-prompt">Prompt</label>
			<textarea
				id="handoff-prompt"
				class={s.INPUT}
				style="font-size: 16px;"
				rows="4"
				placeholder="What should the new agent do?"
				bind:value={prompt}
				disabled={busy}
			></textarea>

			<!-- sticky footer: see AgentDialog.svelte's note on why. -->
			<div
				class="sticky bottom-0 -mx-4 mt-4 -mb-4 flex flex-wrap justify-end gap-2 border-t border-line bg-white px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6 dark:border-white/10 dark:bg-gray-800"
			>
				<button type="button" onclick={onclose} class={s.SECONDARY} disabled={busy}>
					Cancel
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy || !prompt.trim()}>
					{busy ? "Handing off…" : "Hand off"}
				</button>
			</div>
		</form>
	</div>
</Modal>
