<!--
	The machine-policy controls of the Pair-a-machine dialog: one control for
	every `galopin enroll` flag that sets what the machine will ever allow, so
	nobody has to edit the printed command by hand (`FLAG_CONTROLS` names each
	flag's control; `enrollFlags.spec.ts` keeps the two in step).

	Common options sit on top; the rest sit under Advanced, which is collapsed
	until opened but never hides a choice: the preview above carries every
	non-default value, and the summary counts them. Each control has a default
	equal to enroll's own and a default emits no flag (`codeEnrollPolicy.ts`).
	The risky ones (terminal, command shell, trusting repos' own config,
	dropping the secret list, a bash ceiling of Allow) read in an amber tone.

	The ceiling table is the one control that is not one flag per row: the
	flag replaces enroll's default set, so a single changed row writes all of
	it, and the table says so.
-->
<script lang="ts">
	import IconWarning from "~icons/carbon/warning-filled";
	import IconClose from "~icons/carbon/close";
	import {
		CEILING_ACTIONS,
		CEILING_KEYS,
		advancedChangedCount,
		ceilingChanged,
		maxTerminalsProblem,
		ruleKeyProblem,
		type CeilingAction,
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
		| "noDefaultFileDeny";

	const ACTION_LABEL: Record<CeilingAction, string> = {
		allow: "Allow",
		ask: "Ask",
		deny: "Deny",
	};

	let advancedCount = $derived(advancedChangedCount(choices));
	let ceilingEdited = $derived(ceilingChanged(choices.ceiling));
	let terminalProblem = $derived(maxTerminalsProblem(choices.maxTerminals));

	const FIELD =
		"rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-blue-600 focus:outline-hidden";
	const SMALL_BTN =
		"rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken";
</script>

<!-- A checkbox with its one sentence. `risky` tints the label amber and adds
     the warning mark: the owner should feel what these open. -->
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
					aria-label="{label} {index + 1}"
					bind:value={values[index]}
				/>
				<button
					type="button"
					class="flex size-6 items-center justify-center rounded-lg text-ink-muted hover:bg-sunken"
					aria-label="Remove {label.toLowerCase()} {index + 1}"
					onclick={() => remove(index)}><IconClose class="size-3.5" /></button
				>
			</div>
		{/each}
		<button type="button" class="{SMALL_BTN} mt-1.5" onclick={add}>Add</button>
	</div>
{/snippet}

<div data-testid="enroll-policy">
	<p class="mb-1 text-xs font-medium text-ink">What this machine will ever allow</p>
	<p class="mb-3 text-xs text-ink-muted" data-testid="enroll-fixed-note">
		These are fixed when the machine enrolls. Loosening one later means enrolling again; <code
			class="font-mono">galopin policy set</code
		> on the machine can only tighten.
	</p>

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
					<IconWarning class="mr-0.5 inline size-3 align-text-top" />Allow terminals.</span
				>
				The panel can open a real shell on this machine: anyone who controls your Cerea session can run
				commands as you, with no model and no permission rule in the way.
			</span>
		</label>
		{#if choices.allowTerminal}
			<label class="mt-1.5 ml-6 flex items-center gap-2">
				<span>At most</span>
				<input
					type="number"
					min="1"
					step="1"
					class="{FIELD} w-16"
					data-testid="enroll-max-terminals"
					aria-label="Maximum open terminals"
					bind:value={choices.maxTerminals}
				/>
				<span>terminals open at once.</span>
			</label>
			{#if terminalProblem}
				<p
					class="mt-1 ml-6 text-red-600 dark:text-red-400"
					data-testid="enroll-max-terminals-problem"
				>
					{terminalProblem} Until fixed, the printed command leaves the default of 8.
				</p>
			{/if}
		{/if}
	</div>

	<div class="mb-3 text-xs text-ink-muted" data-testid="enroll-ceiling">
		<p>
			<span class="font-medium text-ink">The ceiling.</span> The most each tool may ever do on this machine,
			whatever a session's setting or an “always” says. Changing any row writes the whole table, since
			the flag replaces the default.
		</p>
		<table class="mt-1.5 w-full">
			<tbody>
				{#each CEILING_KEYS as key (key)}
					<tr>
						<th scope="row" class="py-0.5 pr-2 text-left font-mono font-normal text-ink">{key}</th>
						<td class="py-0.5">
							<select
								class={FIELD}
								data-testid="enroll-ceiling-{key}"
								aria-label="Most {key} may do"
								bind:value={choices.ceiling[key]}
							>
								{#each CEILING_ACTIONS as action (action)}
									<option value={action}>{ACTION_LABEL[action]}</option>
								{/each}
							</select>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if choices.ceiling.bash === "allow"}
			<p class="mt-1.5 text-amber-700 dark:text-amber-400" data-testid="enroll-bash-allow-warning">
				<IconWarning class="mr-0.5 inline size-3 align-text-top" />bash set to Allow: a bash that
				runs unchecked can read the agent's own server password and widen its own rules. Leave it on
				Ask unless this machine is disposable.
			</p>
		{/if}
		{#if ceilingEdited}
			<p class="mt-1.5" data-testid="enroll-ceiling-edited">
				Changed: the command now carries the whole table, so a row left as Allow is uncapped.
			</p>
		{/if}
	</div>

	{@render flag(
		"allowProjectConfig",
		"enroll-allow-project-config",
		"Trust the repos this machine opens.",
		"A repo you cloned can carry its own assistant setup — extra commands, helpers and connections — which normally stays switched off, because those are someone else's files. Turn this on only where you trust the repos. Your AI provider stays locked to our gateway either way.",
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
			<span class="font-medium text-ink">Install opencode.</span> The agent runs the opencode binary as
			its coding engine — check this on a fresh machine that does not have it yet (leave it unchecked
			if it is already installed).
		</span>
	</label>

	<details class="mb-3 rounded-lg border border-line p-2" data-testid="enroll-advanced">
		<summary class="cursor-pointer text-xs font-medium text-ink">
			Advanced
			{#if advancedCount > 0}
				<span
					class="ml-1 rounded-full bg-blue-50 px-1.5 py-0.5 font-normal text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
					data-testid="enroll-advanced-count"
				>
					{advancedCount} changed
				</span>
			{/if}
		</summary>
		<div class="mt-3">
			{@render flag(
				"allowCommandShell",
				"enroll-allow-command-shell",
				"Allow the command shell.",
				"A slash command's template may run shell snippets from the repo, inside opencode and before any permission rule is asked.",
				true
			)}
			{@render flag(
				"allowBackgroundSubagents",
				"enroll-allow-background-subagents",
				"Allow background subagents.",
				"A task can keep running after its parent turn ends, with its result handed back later."
			)}
			{@render flag(
				"noAgentTools",
				"enroll-no-agent-tools",
				"No agent tools.",
				"Install none of galopin's session_list, session_spawn and session_send tools, so sessions cannot start or message each other."
			)}
			{@render flag(
				"allowFreeModels",
				"enroll-allow-free-models",
				"Allow free models.",
				"List and accept models from providers other than the gateway's, so spend can land outside the account this machine enrolled under."
			)}
			{@render flag(
				"allowOpencodeProvider",
				"enroll-allow-opencode-provider",
				"Keep opencode's own providers.",
				"Leave opencode's built-in providers enabled beside the gateway's models."
			)}
			{@render listField(
				"enroll-workspace-roots",
				"Workspace folders.",
				"Only these folders, and anything below them, can be opened as a workspace; with none listed, anywhere can.",
				choices.workspaceRoots,
				"/home/me/projects",
				() => choices.workspaceRoots.push(""),
				(index) => choices.workspaceRoots.splice(index, 1)
			)}
			{@render flag(
				"noFiles",
				"enroll-no-files",
				"No file explorer.",
				"Keep the /code explorer out of this machine's workspace files."
			)}
			{@render listField(
				"enroll-file-deny",
				"Hide files.",
				"The explorer also redacts files matching these globs (a name like *.secret, or a path tail like config/prod.yml), on top of the built-in secret list.",
				choices.fileDeny,
				"*.secret",
				() => choices.fileDeny.push(""),
				(index) => choices.fileDeny.splice(index, 1)
			)}
			{@render flag(
				"noDefaultFileDeny",
				"enroll-no-default-file-deny",
				"Drop the built-in secret list.",
				"Stop redacting .env files and private keys in the explorer, keeping only your own globs; it prevents accidents and is not a boundary against the agent.",
				true
			)}

			<div class="text-xs text-ink-muted" data-testid="enroll-permission-rules">
				<p>
					<span class="font-medium text-ink">This machine's own rules</span> (below Cerea's selector).
					A rule for a permission applies to every session here; the ceiling still caps it.
				</p>
				{#each choices.permissionRules as row, index (index)}
					<div class="mt-1 flex items-center gap-1.5">
						<input
							class="{FIELD} min-w-0 flex-1 font-mono"
							placeholder="bash"
							aria-label="Permission for rule {index + 1}"
							bind:value={row.key}
						/>
						<select class={FIELD} aria-label="Action for rule {index + 1}" bind:value={row.action}>
							{#each CEILING_ACTIONS as action (action)}
								<option value={action}>{ACTION_LABEL[action]}</option>
							{/each}
						</select>
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded-lg text-ink-muted hover:bg-sunken"
							aria-label="Remove rule {index + 1}"
							onclick={() => choices.permissionRules.splice(index, 1)}
							><IconClose class="size-3.5" /></button
						>
					</div>
					{#if ruleKeyProblem(row.key)}
						<p class="mt-0.5 text-red-600 dark:text-red-400" data-testid="enroll-rule-problem">
							Rule {index + 1}: {ruleKeyProblem(row.key)} The machine refuses this enroll as written.
						</p>
					{/if}
				{/each}
				<button
					type="button"
					class="{SMALL_BTN} mt-1.5"
					onclick={() => choices.permissionRules.push({ key: "", action: "ask" })}>Add rule</button
				>
			</div>
		</div>
	</details>
</div>
