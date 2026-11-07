<!--
	"New agent session" from the top of the sidebar, without first finding a
	folder in the tree: pick the machine and the folder, then the same dialog the
	tree's per-folder action opens (`AgentDialog`) asks for the rest.

	It opens on the machine and folder you used last (kept in this browser), or
	the first paired machine. A folder the machine does not know yet is added with
	the same dialog the tree uses (`WorkspaceDialog`). With no machine paired
	there is nothing to choose, so it opens the pairing dialog instead.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { m } from "$lib/paraglide/messages";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import Modal from "$lib/components/Modal.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import WorkspaceDialog from "./WorkspaceDialog.svelte";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import { listWorkspaces } from "$lib/codeApi";
	import { codeDeviceList, refreshCodeDevices } from "$lib/stores/codeDeviceList.svelte";
	import { readLastAgentTarget, writeLastAgentTarget } from "$lib/utils/lastAgentTarget";
	import type { CodeWorkspace } from "$lib/types/CodeAgent";
	import * as s from "$lib/components/overlay/styles";
	import IconFolder from "~icons/carbon/folder";

	interface Props {
		onclose: () => void;
	}
	let { onclose }: Props = $props();

	const paired = $derived(codeDeviceList.devices.filter((d) => d.status === "paired"));
	const last = readLastAgentTarget();

	let deviceId = $state(
		untrack(
			() =>
				(last && paired.some((d) => d.id === last.deviceId) ? last.deviceId : paired[0]?.id) ?? ""
		)
	);
	let workspaces = $state<CodeWorkspace[]>([]);
	let workspaceId = $state("");
	let loading = $state(false);
	let failure = $state<string | null>(null);
	let step = $state<"choose" | "folder" | "session">("choose");

	const workspace = $derived(workspaces.find((w) => w.id === workspaceId));
	const device = $derived(paired.find((d) => d.id === deviceId));

	let loadedFor = "";
	$effect(() => {
		const id = deviceId;
		if (!id || id === loadedFor) return;
		loadedFor = id;
		loading = true;
		failure = null;
		workspaces = [];
		workspaceId = "";
		void listWorkspaces(id)
			.then(({ workspaces: found }) => {
				if (id !== deviceId) return;
				workspaces = found;
				workspaceId =
					(last?.deviceId === id && found.some((w) => w.id === last.workspaceId)
						? last.workspaceId
						: found[0]?.id) ?? "";
			})
			.catch((err) => {
				if (id === deviceId)
					failure = err instanceof Error ? err.message : m["code.new_session.could_not_load"]();
			})
			.finally(() => {
				if (id === deviceId) loading = false;
			});
	});

	function created(agentId: string) {
		writeLastAgentTarget({ deviceId, workspaceId });
		void refreshCodeDevices();
		void goto(`${base}/code?device=${deviceId}&ws=${workspaceId}&agent=${agentId}`, {
			keepFocus: true,
		});
		onclose();
	}
</script>

{#if paired.length === 0}
	<PairDeviceDialog {onclose} onpaired={() => onclose()} />
{:else if step === "session" && workspace}
	<AgentDialog
		{deviceId}
		{workspace}
		onclose={() => (step = "choose")}
		oncreated={(agent) => created(agent.id)}
	/>
{:else if step === "folder"}
	<WorkspaceDialog
		{deviceId}
		onclose={() => (step = "choose")}
		oncreated={(added) => {
			workspaces = [...workspaces, added];
			workspaceId = added.id;
			step = "session";
		}}
	/>
{:else}
	<Modal width="max-w-md" closeButton labelledBy="new-agent-title" {onclose}>
		<div class="p-6">
			<div class="mb-6 flex items-center gap-3">
				<div class={s.STRIP_TILE}>
					<IconFolder class="size-5 text-blue-600" />
				</div>
				<div>
					<h2 id="new-agent-title" class={s.TITLE}>{m["code.new_session.title"]()}</h2>
					<p class={s.SUBTITLE}>{m["code.new_session.subtitle"]()}</p>
				</div>
			</div>

			{#if failure}
				<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
			{/if}

			<label class={s.LABEL} for="new-agent-machine">{m["code.new_session.machine"]()}</label>
			<select
				id="new-agent-machine"
				class={s.INPUT}
				style="font-size: 16px"
				data-testid="new-agent-machine"
				bind:value={deviceId}
			>
				{#each paired as d (d.id)}
					<option value={d.id}
						>{d.name}{d.online === false ? ` (${m["code.new_session.offline"]()})` : ""}</option
					>
				{/each}
			</select>

			<label class="{s.LABEL} mt-4" for="new-agent-folder">{m["code.new_session.folder"]()}</label>
			<select
				id="new-agent-folder"
				class={s.INPUT}
				style="font-size: 16px"
				data-testid="new-agent-folder"
				bind:value={workspaceId}
				disabled={loading || workspaces.length === 0}
			>
				{#each workspaces as w (w.id)}
					<option value={w.id}>{w.name} · {w.path}</option>
				{/each}
			</select>
			{#if !loading && workspaces.length === 0 && !failure}
				<p class={s.HINT}>{m["code.new_session.no_folders"]()}</p>
			{/if}
			<button
				type="button"
				class="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
				disabled={device?.online === false}
				onclick={() => (step = "folder")}
			>
				{m["code.new_session.add_folder"]()}
			</button>

			<div class="mt-6 flex justify-end gap-2">
				<button type="button" onclick={onclose} class={s.SECONDARY}>
					{m["code.common.cancel"]()}
				</button>
				<button
					type="button"
					class={s.PRIMARY}
					data-testid="new-agent-continue"
					disabled={!workspace}
					onclick={() => (step = "session")}
				>
					{m["code.new_session.continue"]()}
				</button>
			</div>
		</div>
	</Modal>
{/if}
