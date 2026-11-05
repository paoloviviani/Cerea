<!--
	The Permissions sheet, opened from the shield beside the composer's Plan / Ask / Auto step (and
	from a session's menu in the agents sidebar): what reaches the user on this machine, class by
	class (ADR 0107 section 3), from the machine's limits (its hello), the administrator's rows and
	the reviewer's availability. Then the session's Exceptions (what "Always allow" on a card left
	behind, with Remove) and the Coordination switches. The exceptions and the grant are read from
	the machine for this session (`permission.rules`) and re-read after every change; the machine's
	own rules are never listed.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import { untrack } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import {
		CodeApiError,
		getAutoApproval,
		getPermissionRules,
		removeSavedApproval,
		setCoordinationGrant,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import type { PermissionMode, PermissionRulesResult, Policy } from "$lib/types/machineProtocol";
	import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
	import { isLegacyMachine } from "$lib/utils/permissionRules";
	import {
		className,
		classRows,
		expectationLine,
		outcomeText,
		reasonText,
		thirdStepLabel,
		type AutoSetup,
	} from "$lib/utils/autoApproval";
	import {
		ceilingNote,
		coordinationKeys,
		coordinationOptions,
		coordinationSupport,
		type CoordinationOptions,
	} from "$lib/utils/coordination";
	import { error as errorToast } from "$lib/stores/errors";
	import IconShield from "~icons/lucide/shield";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The session's step (Plan is the wire's `deny`), for the one sentence on what
		 * reaches the user; the sentence is left out when unknown. */
		mode?: PermissionMode | null;
		/** The reviewer's availability and the administrator's rows; read here when the
		 * opener has none. */
		setup?: AutoSetup | null;
		/** The device row this session belongs to, for the coordination
		 * switches' disabled reasons (a galopin too old to grant, agent tools
		 * off) and the ceiling note. Unknown when the tree has not loaded
		 * it — the switches stay usable and the grant itself answers. */
		device?: CodeDeviceView;
		/** A subagent holds no grant of its own (it follows its root):
		 * the section says so instead of offering the switches. */
		subagent?: boolean;
		/** Called after an exception is removed (the dialog re-reads itself);
		 * a parent showing the exceptions count re-reads with it. */
		onchanged?: () => void;
		/** The machine's `hello` policy, to tell a machine that predates
		 * ceilings from one that has none to report yet. */
		policy?: Policy;
		/** Opens the enroll flow, for a machine flagged as legacy. */
		onreenroll?: () => void;
		onclose: () => void;
	}

	let {
		deviceId,
		agentId,
		mode = null,
		setup: given,
		device,
		subagent = false,
		onchanged,
		policy,
		onreenroll,
		onclose,
	}: Props = $props();

	let removing = $state<string | null>(null);
	let coordinating = $state(false);

	/** The machine's `permission.rules` answer for this session, read here:
	 * the dialog owns its read, so it can be opened for any session's row,
	 * selected or not. A failed read keeps the last good answer; a 404 (a
	 * galopin that predates the op) is said, not retried. */
	let result = $state<PermissionRulesResult | null>(null);
	let missing = $state(false);
	let loading = $state(true);
	let loadToken = 0;

	async function load() {
		const token = ++loadToken;
		loading = true;
		try {
			const read = await getPermissionRules(deviceId, agentId);
			if (token === loadToken) {
				result = read;
				missing = false;
			}
		} catch (err) {
			if (token === loadToken) {
				missing = err instanceof CodeApiError && err.status === 404;
				if (missing) result = null;
			}
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	$effect(() => {
		void deviceId;
		void agentId;
		untrack(() => void load());
	});

	let exceptions = $derived(result?.savedApprovals ?? []);

	/** The reviewer's side, from the opener when it has it, else read once. */
	let fetched = $state<AutoSetup | null>(null);
	$effect(() => {
		if (given !== undefined) return;
		untrack(() => {
			getAutoApproval()
				.then((v) => (fetched = { reviewerAvailable: v.available, perClass: v.perClass }))
				.catch(() => (fetched = null));
		});
	});
	let setup = $derived<AutoSetup>({
		...(given ?? fetched ?? { reviewerAvailable: false, perClass: {} as AutoSetup["perClass"] }),
		neverReview: (given ?? fetched)?.neverReview || device?.neverReview === true,
	});
	let computed = $derived(classRows(device?.policy ?? policy, setup));
	let label = $derived(thirdStepLabel(setup));
	let machineName = $derived(device?.name ?? "");
	let stepSentence = $derived(
		mode === "deny"
			? m["code.permissions.step_plan"]()
			: mode === "ask"
				? m["code.permissions.step_ask"]()
				: mode === "allow"
					? expectationLine(machineName, computed.rows, label)
					: ""
	);

	/** A machine enrolled before ceilings: nothing caps its Allow. Said up
	 * front, never inside the collapsed detail. */
	let legacy = $derived(isLegacyMachine(policy, result));
	$effect(() => {
		// Remembered per machine, so its row in the tree carries the flag after
		// this dialog is closed. Cleared again if a re-enroll makes it go away.
		if (result) codeLegacyMachines[deviceId] = legacy;
	});

	async function remove(id: string) {
		if (removing) return;
		removing = id;
		try {
			await removeSavedApproval(deviceId, agentId, id);
			await load();
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : m["code.permissions.could_not_remove"]());
		} finally {
			removing = null;
		}
	}

	/** The session's grant read back as the two switches, in the same
	 * wording the schedules use (utils/coordination.ts). */
	let grant = $derived(coordinationOptions(result?.coordination ?? []));
	/** Whether the machine can take a grant at all; null while the device
	 * row is unknown — the switches stay usable and the grant itself
	 * answers (an old galopin 404s with the reason). */
	let grantable = $derived(device ? coordinationSupport(device) : null);
	let ceilingWarning = $derived(device ? ceilingNote(device, result?.coordination ?? []) : null);

	async function setGrant(next: CoordinationOptions) {
		if (coordinating) return;
		coordinating = true;
		try {
			await setCoordinationGrant(deviceId, agentId, coordinationKeys(next));
			await load();
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : m["code.permissions.could_not_grant"]());
		} finally {
			coordinating = false;
		}
	}
</script>

<Modal width="max-w-xl" closeButton labelledBy="permissions-dialog-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconShield class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0 pr-8">
				<h2 id="permissions-dialog-title" class="{s.TITLE} break-words">
					{machineName
						? m["code.permissions.title"]({ machine: machineName })
						: m["code.permissions.title_plain"]()}
				</h2>
				<p class="{s.SUBTITLE} break-words">
					{m["code.permissions.subtitle"]()}
				</p>
			</div>
		</div>

		{#if result && !codeReauth.required}
			<div class="flex flex-col gap-2 text-sm" data-testid="permissions-detail">
				{#if legacy}
					<div
						class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
						data-testid="legacy-machine-flag"
					>
						<span class="min-w-0 flex-1">
							<span class="font-medium">{m["code.permissions.legacy_title"]()}</span>
							{m["code.permissions.legacy_detail"]()}
						</span>
						{#if onreenroll}
							<button
								type="button"
								class="shrink-0 rounded-lg border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-transparent dark:text-amber-200"
								onclick={onreenroll}>{m["code.permissions.reenroll"]()}</button
							>
						{/if}
					</div>
				{/if}

				{#if stepSentence}
					<p class="text-ink" data-testid="permission-step">{stepSentence}</p>
				{/if}
				{#if setup.degraded && label === "auto"}
					<p class="text-amber-700 dark:text-amber-400" data-testid="permission-degraded">
						{m["code.auto.degraded"]()}
					</p>
				{/if}

				<div>
					<p class="mb-1 font-medium text-ink">
						{label === "auto"
							? m["code.permissions.classes_auto"]()
							: m["code.permissions.classes_allow"]()}
					</p>
					{#if computed.older}
						<p class="mb-1 text-ink-muted" data-testid="permission-older">
							{m["code.auto.older_note"]()}
						</p>
					{/if}
					<table class="w-full text-left" data-testid="permission-classes">
						<tbody>
							{#each computed.rows as row (row.class)}
								<tr
									class="border-t border-line align-top"
									data-testid="permission-class-{row.class}"
								>
									<th scope="row" class="py-1 pr-2 font-medium text-ink">{className(row.class)}</th>
									<td class="py-1 pr-2 text-ink" data-testid="permission-outcome-{row.class}"
										>{outcomeText(row)}</td
									>
									<td class="py-1 text-ink-muted" data-testid="permission-reason-{row.class}"
										>{reasonText(row)}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if label === "auto" && setup.reviewerAvailable && !setup.neverReview}
						<a
							href="{base}/settings/review-log"
							class="mt-1 inline-block text-xs text-ink-muted underline hover:text-ink"
							data-testid="permission-review-log-link">{m["code.permissions.review_log_link"]()}</a
						>
					{/if}
				</div>

				<div>
					<p class="mb-1 font-medium text-ink">{m["code.permissions.exceptions"]()}</p>
					{#if exceptions.length === 0}
						<p class="text-ink-muted">
							{m["code.permissions.exceptions_none"]()}
						</p>
					{:else}
						<ul class="flex flex-col gap-1" data-testid="permission-exceptions">
							{#each exceptions as exception (exception.id)}
								<li
									class="flex flex-wrap items-center gap-1.5"
									data-testid="permission-exception-item"
								>
									<span class="text-ink-muted">{m["code.permissions.allowed_for_session"]()}</span>
									<span class="min-w-0 truncate font-mono text-ink">
										{exception.patterns.length > 0
											? exception.patterns.join(", ")
											: exception.permission}
									</span>
									{#if exception.permission !== "bash" && exception.patterns.length > 0}
										<span class="text-ink-faint">({exception.permission})</span>
									{/if}
									<span class="min-w-0 flex-1"></span>
									{#if exception.removable === false}
										<span class="text-ink-faint">{m["code.permissions.held"]()}</span>
									{:else}
										<button
											type="button"
											class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
											disabled={removing !== null}
											title={m["code.permissions.remove_title"]()}
											aria-label={m["code.permissions.remove_label"]({
												permission: exception.permission,
											})}
											onclick={() => void remove(exception.id)}
										>
											{removing === exception.id
												? m["code.permissions.removing"]()
												: m["code.permissions.remove"]()}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
						<p class="mt-1 text-ink-faint">
							{m["code.permissions.exceptions_note"]()}
						</p>
					{/if}
				</div>

				<div>
					<p class="mb-1 font-medium text-ink">{m["code.permissions.coordination"]()}</p>
					{#if subagent}
						<p class="text-ink-muted">
							{m["code.permissions.subagent_note"]()}
						</p>
					{:else if grantable && !grantable.ok}
						<p class="text-ink-muted" data-testid="coordination-unavailable">
							{grantable.reason === "tools-off"
								? m["code.permissions.coord_tools_off"]()
								: m["code.permissions.coord_too_old"]()}
						</p>
					{:else}
						<div
							class="space-y-2"
							role="group"
							aria-label={m["code.permissions.coordination_label"]()}
							data-testid="coordination-options"
						>
							<label class="flex items-start gap-2 text-sm text-ink">
								<input
									type="checkbox"
									class="mt-1"
									checked={grant.canMessage}
									disabled={coordinating}
									onchange={() =>
										void setGrant({ canMessage: !grant.canMessage, canSpawn: grant.canSpawn })}
								/>
								<span>{m["code.permissions.can_message"]()}</span>
							</label>
							<label class="flex items-start gap-2 text-sm text-ink">
								<input
									type="checkbox"
									class="mt-1"
									checked={grant.canSpawn}
									disabled={coordinating}
									onchange={() =>
										void setGrant({ canMessage: grant.canMessage, canSpawn: !grant.canSpawn })}
								/>
								<span>{m["code.permissions.can_spawn"]()}</span>
							</label>
						</div>
						<p class="mt-1 text-ink-faint">
							{m["code.permissions.grant_note"]()}
						</p>
						{#if ceilingWarning}
							<p class="mt-1 text-ink-faint">{ceilingWarning}</p>
						{/if}
					{/if}
				</div>
			</div>
		{:else if !codeReauth.required}
			{#if loading}
				<p class="text-sm text-ink-muted" data-testid="permissions-loading">
					{m["code.permissions.reading"]()}
				</p>
			{:else if missing}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					{m["code.permissions.too_old"]()}
				</p>
			{:else}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					{m["code.permissions.no_answer"]()}
				</p>
			{/if}
		{/if}
		<!-- While the sign-in is stale the detail goes, with the fallback:
		     the server refuses every call anyway, and what it held was
		     machine-derived. -->
	</div>
</Modal>
