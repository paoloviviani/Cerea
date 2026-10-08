<!--
	The machine-policy controls of the Pair-a-machine dialog: one control for
	every `galopin enroll` flag that sets what the machine will ever allow, so
	nobody has to edit the printed command by hand (`FLAG_CONTROLS` names each
	flag's control; `enrollFlags.spec.ts` keeps the two in step).

	Common options sit on top: the ceiling for all tools at once (three pills),
	trusting repos, and installing opencode. The rest sit under Advanced, which
	is collapsed until opened but never hides a choice: the preview above
	carries every non-default value, and the summary counts them. Each control
	has a default equal to enroll's own and a default emits no flag
	(`codeEnrollPolicy.ts`) — terminals, the command shell and background
	subagents are on by default, so only turning one off prints anything. The
	risky ones (terminal, command shell, trusting repos' own config, dropping
	the secret list, a bash ceiling of Allow) read in an amber tone.

	The ceiling is the one control that is not one flag per row: the flag
	replaces enroll's default set, so a single changed row writes all of it.
	"All tools" sets every row; the rows themselves sit under Advanced.
-->
<script lang="ts">
	import IconWarning from "~icons/carbon/warning-filled";
	import { page } from "$app/state";
	import IconClose from "~icons/carbon/close";
	import {
		CEILING_ACTIONS,
		CEILING_KEYS,
		advancedChangedCount,
		ceilingChanged,
		uniformCeiling,
		maxTerminalsProblem,
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
		| "noDefaultFileDeny"
		| "allowOutsideProject"
		| "allowSecretReads";

	const ACTION_LABEL: Record<CeilingAction, string> = {
		allow: "Allow",
		ask: "Ask",
		deny: "Deny",
	};

	let advancedCount = $derived(advancedChangedCount(choices));
	let allTools = $derived(uniformCeiling(choices.ceiling));

	function setAllTools(action: CeilingAction) {
		for (const key of CEILING_KEYS) choices.ceiling[key] = action;
	}

	let ceilingEdited = $derived(ceilingChanged(choices.ceiling));
	let terminalProblem = $derived(maxTerminalsProblem(choices.maxTerminals));

	const FIELD =
		"rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-blue-600 focus:outline-hidden";
	const PILL =
		"rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors aria-pressed:border-blue-600 aria-pressed:bg-blue-600 aria-pressed:text-white";
	const PILL_OFF = "border-line text-ink-muted hover:bg-sunken";
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

<!-- Allow · Ask · Deny side by side: one click, the current one pressed. -->
{#snippet pills(
	testid: string,
	label: string,
	current: CeilingAction | null,
	pick: (action: CeilingAction) => void
)}
	<div class="flex gap-1" role="group" aria-label={label} data-testid={testid}>
		{#each CEILING_ACTIONS as action (action)}
			<button
				type="button"
				class="{PILL} {current === action ? '' : PILL_OFF}"
				aria-pressed={current === action}
				onclick={() => pick(action)}>{ACTION_LABEL[action]}</button
			>
		{/each}
	</div>
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

	<div class="mb-3 text-xs text-ink-muted" data-testid="enroll-ceiling">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p>
				<span class="font-medium text-ink">The most any session may do here.</span>
				A cap no session's Deny / Ask / Allow setting, and no “always allow”, can go past.
			</p>
			{@render pills("enroll-ceiling-all", "All tools", allTools, setAllTools)}
		</div>
		{#if allTools === null}
			<p class="mt-1" data-testid="enroll-ceiling-mixed">
				{#if ceilingChanged(choices.ceiling)}
					Set per tool under Advanced.
				{:else}
					Default: commands (bash) and starting new sessions ask; everything else is allowed. Set
					per tool under Advanced.
				{/if}
			</p>
		{/if}
		{#if choices.ceiling.bash === "allow"}
			<p class="mt-1.5 text-amber-700 dark:text-amber-400" data-testid="enroll-bash-allow-warning">
				<IconWarning class="mr-0.5 inline size-3 align-text-top" />Commands (bash) may run without
				asking: a command that runs unchecked can read the agent's own server password and widen its
				own rules. Keep bash on Ask unless this machine is disposable.
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
							<IconWarning class="mr-0.5 inline size-3 align-text-top" />Terminals.</span
						>
						On by default. The panel can open a real shell on this machine: anyone who controls your Cerea
						session can run commands as you, with no model and no permission rule in the way.
					</span>
				</label>
				{#if page.data.codeTerminalEnabled !== true}
					<!-- The deployment's half of the double veto: while it is off no
					     terminal is offered at all, whatever this box says. The box
					     stays, so turning the deployment's switch on later needs no
					     re-enroll. -->
					<p class="mt-1 ml-6 text-ink-muted" data-testid="enroll-terminal-deployment-off">
						Terminal is off for this deployment: none is offered until an administrator turns it on
						(<code>./configure --terminal</code>). This box decides what this machine allows then.
					</p>
				{/if}
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
			{@render flag(
				"allowCommandShell",
				"enroll-allow-command-shell",
				"Slash commands that run shell.",
				"On by default. A slash command whose template runs a shell snippet (!`git diff`, say) may run it, inside opencode and before any permission is asked: the snippet is code from the repo. Plain slash commands work either way.",
				true
			)}
			{@render flag(
				"allowBackgroundSubagents",
				"enroll-allow-background-subagents",
				"Background subagents.",
				"On by default. A task can keep running after its parent turn ends, with its result handed back later."
			)}

			<div class="mb-3 text-xs text-ink-muted" data-testid="enroll-ceiling-rows">
				<p class="mb-1"><span class="font-medium text-ink">The cap, tool by tool.</span></p>
				<table class="w-full">
					<tbody>
						{#each CEILING_KEYS as key (key)}
							<tr>
								<th scope="row" class="py-0.5 pr-2 text-left font-mono font-normal text-ink"
									>{key}</th
								>
								<td class="py-0.5">
									{@render pills(
										`enroll-ceiling-${key}`,
										`Most ${key} may do`,
										choices.ceiling[key],
										(action) => (choices.ceiling[key] = action)
									)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if ceilingEdited}
					<p class="mt-1.5" data-testid="enroll-ceiling-edited">
						Changed: the command now carries the whole table, so a tool left on Allow is uncapped.
					</p>
				{/if}
			</div>
			{@render flag(
				"noAgentTools",
				"enroll-no-agent-tools",
				"No agent tools.",
				"Install none of galopin's session_list, session_read, session_spawn and session_send tools, so sessions cannot find, read, start or message each other."
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

			<div data-testid="enroll-fixed-answers">
				{@render flag(
					"allowOutsideProject",
					"enroll-allow-outside-project",
					"Agents may work outside the project folder without asking.",
					"By default an agent asks before reading or writing files outside the workspace folder; ticked, it doesn't."
				)}
				{@render flag(
					"allowSecretReads",
					"enroll-allow-secret-reads",
					"Agents may read secret files without asking.",
					"By default an agent asks before reading .env and similar files; ticked, it reads them like any other file, so their contents reach the model.",
					true
				)}
			</div>
		</div>
	</details>
</div>
