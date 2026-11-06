<!--
	The machine-policy controls of the Pair-a-machine dialog: one control for
	every `galopin enroll` flag that sets what the machine will ever allow, so
	nobody has to edit the printed command by hand (`FLAG_CONTROLS` names each
	flag's control; `enrollFlags.spec.ts` keeps the two in step).

	Common options sit on top: trusting repos, and installing opencode. The rest sit under Advanced, which
	is collapsed until opened but never hides a choice: the preview above
	carries every non-default value, and the summary counts them. Each control
	has a default equal to enroll's own and a default emits no flag
	(`codeEnrollPolicy.ts`) — terminals, the command shell and background
	subagents are on by default, so only turning one off prints anything. The
	one exception is Bill to my default group, which the dialog ticks by
	default while `enroll` itself keeps requiring an explicit `--default-group`:
	unticking it is what removes the flag. The
	risky ones (terminal, command shell, trusting repos' own config, dropping
	the secret list, commands that run without a card) read in an amber tone.

	There are no machine limits (ADR 0109): what runs, is reviewed or comes to you is chosen per
	session (Plan, Ask, Auto, Allow) and in Workspace, Agents.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import IconWarning from "~icons/carbon/warning-filled";
	import { page } from "$app/state";
	import IconClose from "~icons/carbon/close";
	import {
		advancedChangedCount,
		maxTerminalsProblem,
		type EnrollPolicyChoices,
	} from "$lib/codeEnrollPolicy";

	interface Props {
		choices: EnrollPolicyChoices;
		/** Whether the opencode install line is part of the command: the one
		 * common option that is not machine policy. */
		installOpencode: boolean;
	}

	let { choices = $bindable(), installOpencode = $bindable() }: Props = $props();

	type BooleanKey =
		| "allowProjectConfig"
		| "allowCommandShell"
		| "allowBackgroundSubagents"
		| "noAgentTools"
		| "allowFreeModels"
		| "allowOpencodeProvider"
		| "noFiles"
		| "allowFileWrite"
		| "noDefaultFileDeny"
		| "billToDefault";

	let advancedCount = $derived(advancedChangedCount(choices));
	let terminalProblem = $derived(maxTerminalsProblem(choices.maxTerminals));

	const FIELD =
		"rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-blue-600 focus:outline-hidden";
	const SMALL_BTN =
		"rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken";
</script>

<!-- A checkbox with its one sentence. `risky` tints the label amber and adds
     the warning mark: the owner should feel what these open. -->
{#snippet inlineCode(text: string)}<code class="font-mono">{text}</code>{/snippet}
{#snippet plainCode(text: string)}<code>{text}</code>{/snippet}
{#snippet flag(key: BooleanKey, testid: string, label: string, text: string, risky = false)}
	<label class="mb-3 flex items-start gap-2 text-xs text-ink-muted">
		<input type="checkbox" class="mt-0.5" data-testid={testid} bind:checked={choices[key]} />
		<span>
			<span
				class="font-medium {risky ? 'text-amber-700 dark:text-amber-400' : 'text-ink'}"
				data-risky={risky ? "true" : undefined}
			>
				{#if risky}<IconWarning class="mr-0.5 inline size-3 align-text-top" />{/if}{label}</span
			>
			{text}
		</span>
	</label>
{/snippet}

<!-- A repeatable list: one text field per entry, Add and Remove. -->
{#snippet listField(
	testid: string,
	label: string,
	text: string,
	values: string[],
	placeholder: string,
	add: () => void,
	remove: (index: number) => void
)}
	<div class="mb-3 text-xs text-ink-muted" data-testid={testid}>
		<p><span class="font-medium text-ink">{label}</span> {text}</p>
		{#each values as _, index (index)}
			<div class="mt-1 flex items-center gap-1.5">
				<input
					class="{FIELD} min-w-0 flex-1 font-mono"
					{placeholder}
					aria-label={m["code.enroll.list_item"]({ label, index: index + 1 })}
					bind:value={values[index]}
				/>
				<button
					type="button"
					class="flex size-6 items-center justify-center rounded-lg text-ink-muted hover:bg-sunken"
					aria-label={m["code.enroll.list_remove"]({
						label: label.toLowerCase(),
						index: index + 1,
					})}
					onclick={() => remove(index)}><IconClose class="size-3.5" /></button
				>
			</div>
		{/each}
		<button type="button" class="{SMALL_BTN} mt-1.5" onclick={add}>{m["code.enroll.add"]()}</button>
	</div>
{/snippet}

<div data-testid="enroll-policy">
	<p class="mb-1 text-xs font-medium text-ink">{m["code.enroll.title"]()}</p>
	<p class="mb-3 text-xs text-ink-muted" data-testid="enroll-fixed-note">
		<Rich parts={m["code.enroll.fixed_note"].parts()} tags={{ code: inlineCode }} />
	</p>

	{@render flag(
		"allowProjectConfig",
		"enroll-allow-project-config",
		m["code.enroll.trust_label"](),
		m["code.enroll.trust_text"](),
		true
	)}

	<label class="mb-3 flex items-start gap-2 text-xs text-ink-muted">
		<input
			type="checkbox"
			class="mt-0.5"
			data-testid="enroll-install-opencode"
			bind:checked={installOpencode}
		/>
		<span>
			<span class="font-medium text-ink">{m["code.enroll.install_opencode_label"]()}</span>
			{m["code.enroll.install_opencode_text"]()}
		</span>
	</label>

	<details class="mb-3 rounded-lg border border-line p-2" data-testid="enroll-advanced">
		<summary class="cursor-pointer text-xs font-medium text-ink">
			{m["code.enroll.advanced"]()}
			{#if advancedCount > 0}
				<span
					class="ml-1 rounded-full bg-blue-50 px-1.5 py-0.5 font-normal text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
					data-testid="enroll-advanced-count"
				>
					{m["code.enroll.advanced_changed"]({ count: advancedCount })}
				</span>
			{/if}
		</summary>
		<div class="mt-3">
			{@render flag(
				"billToDefault",
				"enroll-bill-to-default",
				m["code.enroll.bill_label"](),
				m["code.enroll.bill_text"]()
			)}
			<div class="mb-3 text-xs text-ink-muted">
				<label class="flex items-start gap-2">
					<input
						type="checkbox"
						class="mt-0.5"
						data-testid="enroll-allow-terminal"
						bind:checked={choices.allowTerminal}
					/>
					<span>
						<span class="font-medium text-amber-700 dark:text-amber-400" data-risky="true">
							<IconWarning class="mr-0.5 inline size-3 align-text-top" />{m[
								"code.enroll.terminals_label"
							]()}</span
						>
						{m["code.enroll.terminals_text"]()}
					</span>
				</label>
				{#if page.data.codeTerminalEnabled !== true}
					<!-- The deployment's half of the double veto: while it is off no
					     terminal is offered at all, whatever this box says. The box
					     stays, so turning the deployment's switch on later needs no
					     re-enroll. -->
					<p class="mt-1 ml-6 text-ink-muted" data-testid="enroll-terminal-deployment-off">
						<Rich parts={m["code.enroll.terminals_off"].parts()} tags={{ code: plainCode }} />
					</p>
				{/if}
				{#if choices.allowTerminal}
					<label class="mt-1.5 ml-6 flex items-center gap-2">
						<span>{m["code.enroll.max_terminals_before"]()}</span>
						<input
							type="number"
							min="1"
							step="1"
							class="{FIELD} w-16"
							data-testid="enroll-max-terminals"
							aria-label={m["code.enroll.max_terminals_label"]()}
							bind:value={choices.maxTerminals}
						/>
						<span>{m["code.enroll.max_terminals_after"]()}</span>
					</label>
					{#if terminalProblem}
						<p
							class="mt-1 ml-6 text-red-600 dark:text-red-400"
							data-testid="enroll-max-terminals-problem"
						>
							{m["code.enroll.max_terminals_problem"]({ problem: terminalProblem })}
						</p>
					{/if}
				{/if}
			</div>
			{@render flag(
				"allowCommandShell",
				"enroll-allow-command-shell",
				m["code.enroll.shell_label"](),
				m["code.enroll.shell_text"](),
				true
			)}
			{@render flag(
				"allowBackgroundSubagents",
				"enroll-allow-background-subagents",
				m["code.enroll.subagents_label"](),
				m["code.enroll.subagents_text"]()
			)}

			{@render flag(
				"noAgentTools",
				"enroll-no-agent-tools",
				m["code.enroll.no_tools_label"](),
				m["code.enroll.no_tools_text"]()
			)}
			{@render flag(
				"allowFreeModels",
				"enroll-allow-free-models",
				m["code.enroll.free_label"](),
				m["code.enroll.free_text"]()
			)}
			{@render flag(
				"allowOpencodeProvider",
				"enroll-allow-opencode-provider",
				m["code.enroll.provider_label"](),
				m["code.enroll.provider_text"]()
			)}
			{@render listField(
				"enroll-workspace-roots",
				m["code.enroll.roots_label"](),
				m["code.enroll.roots_text"](),
				choices.workspaceRoots,
				"/home/me/projects",
				() => choices.workspaceRoots.push(""),
				(index) => choices.workspaceRoots.splice(index, 1)
			)}
			{@render flag(
				"noFiles",
				"enroll-no-files",
				m["code.enroll.no_files_label"](),
				m["code.enroll.no_files_text"]()
			)}
			{@render flag(
				"allowFileWrite",
				"enroll-allow-file-write",
				m["code.enroll.file_write_label"](),
				m["code.enroll.file_write_text"](),
				true
			)}
			{@render listField(
				"enroll-file-deny",
				m["code.enroll.deny_label"](),
				m["code.enroll.deny_text"](),
				choices.fileDeny,
				"*.secret",
				() => choices.fileDeny.push(""),
				(index) => choices.fileDeny.splice(index, 1)
			)}
			{@render flag(
				"noDefaultFileDeny",
				"enroll-no-default-file-deny",
				m["code.enroll.drop_label"](),
				m["code.enroll.drop_text"](),
				true
			)}
		</div>
	</details>
</div>
