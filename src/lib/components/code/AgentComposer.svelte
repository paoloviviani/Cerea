<!--
	A follow-up, with the agent's own settings attached — in the chat's
	own composer.

	The textarea is ChatInput with the default props: no mime types to offer
	(no upload affordances), no conversation to PATCH (so no web-search or
	knowledge or tool-approval pills either — the pill row hides with an
	empty allowlist), no hub mentions. What renders instead are the pills
	the agent owns, in the chat composer's own pill idiom and inside the
	prompt box like chat's: the mode (the backend's permission vocabulary —
	plan, build, … — listed live from the machine, never a hardcoded set
	that would drift from what it enforces) and the model. Both apply live
	to the open agent, not to one send: the licence is the agent's until it
	is switched again (`session.setMode`/`setModel`). Beside them sits the
	permission selector, Deny · Ask · Allow: the session's blanket until
	changed, claimed only from the agent's snapshot (the machine's word, never
	an optimistic guess) and disabled on a subagent, which follows its main
	session.

	While a turn is live the stop control joins the send button in its spot
	(chat's own swap has `ChatWindow` render `StopGeneratingBtn` there) — and
	it stays while a permission card is up, because stopping a prompt nobody
	wants to answer is the point of it. The send button stays too: a prompt
	sent mid-turn STEERS it (opencode folds it into the next step), and its
	chevron offers "Stop and send" for the stop-then-prompt path. Steering
	is for prompts only — a `/` command is still refused while a turn runs.

	There is no provider field: the agent already has one, and
	`session.prompt` takes none.

	The reply is NOT inserted optimistically: the transcript stream echoes
	the person's message back, and the stream is the source of truth.
	Sending twice against a slow machine would print twice.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { MediaQuery } from "svelte/reactivity";
	import { DropdownMenu } from "bits-ui";
	import ComposerFileChips from "$lib/components/chat/ComposerFileChips.svelte";
	import ChatInput from "$lib/components/chat/ChatInput.svelte";
	import StopGeneratingBtn from "$lib/components/StopGeneratingBtn.svelte";
	import IconArrowUp from "~icons/lucide/arrow-up";
	import IconChevronDown from "~icons/carbon/chevron-down";
	import IconCheck from "~icons/carbon/checkmark";
	import IconWarning from "~icons/carbon/warning-filled";
	import { isVirtualKeyboard } from "$lib/utils/isVirtualKeyboard";
	import {
		setAgentMode,
		setPermissionMode,
		setAgentModel,
		setAgentEffort,
		compactAgent,
		unrevertAgent,
		listAgentCommands,
		runAgentCommand,
		CodeApiError,
	} from "$lib/codeApi";
	import type { PermissionMode } from "$lib/types/machineProtocol";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import { ceilingNote } from "$lib/utils/permissionRules";
	import type { CodeProviderMode, CodeProviderModel } from "$lib/types/CodeAgent";
	import { resolveActiveModel } from "$lib/utils/activeModel";
	import ModelEffortPicker from "$lib/components/chat/ModelEffortPicker.svelte";
	import ModelPickerDialog from "$lib/components/ModelPickerDialog.svelte";
	import { error as errorToast } from "$lib/stores/errors";
	import {
		readRecent,
		withRecent,
		CODE_RECENT_MODELS_KEY,
		type PickerModel,
	} from "$lib/utils/modelEffortPicker";
	import type {
		AgentCompactionUpdate,
		AgentUsageUpdate,
		CodeAgentSession,
	} from "$lib/types/CodeAgent";
	import {
		matchSlashCommand,
		panelCommands as panelCommandTable,
		type SlashCommand,
	} from "$lib/utils/slashCommand.svelte";
	import type { CodeCommand } from "$lib/types/CodeAgent";
	import ContextMeter from "./ContextMeter.svelte";
	import CommandConfirmSheet from "./CommandConfirmSheet.svelte";
	import { codeDraftKey } from "$lib/utils/composerDraft";

	interface Props {
		deviceId: string;
		/** The address's agent id — known even when its snapshot read failed. */
		agentId: string;
		/** The open agent's snapshot: the pills' current values are its. Null
		 * when the snapshot read failed, and the pills then carry no claim. */
		agent: CodeAgentSession | null;
		/** The machine's ceiling (`permission.rules.ceiling`): permission key
		 * -> the most it may ever be. The selector's note names what it still
		 * holds back under Allow. Empty until the read lands. */
		ceiling?: Record<string, "ask" | "deny">;
		/** Whether a turn is live on the transcript — the send button's spot
		 * carries the stop control while it is, permission prompts included. */
		running?: boolean;
		/** Set when the device's enrollment probe (on agent open, on device
		 * switch — see `CodePanel`) found the daemon's stored credentials
		 * dead: the send is doomed, so it is refused here rather than left
		 * to fail after the person typed something. */
		enrollmentExpired?: boolean;
		/** Set when the device's own row (`codeDeviceList`) currently reports
		 * it unreachable: the send is refused here, before it can fail on a
		 * 502 the daemon was never asked to answer. */
		offline?: boolean;
		/** Called synchronously with the submit, before the POST — the view
		 * engages the column's follow and raises its pending placeholder. */
		onsend: (text: string, files: File[]) => Promise<void>;
		/** What the picker, paste and chips accept; empty hides the picker. */
		mimeTypes?: string[];
		/** Stops the live turn. The transcript records the ending; this only
		 * carries the request to the daemon. Resolves `false` when the daemon
		 * did not take it, which "Stop and send" reads as "do not send". */
		onstop?: () => void | boolean | Promise<void | boolean>;
		/** Whether this agent's backend takes a per-session thinking effort
		 * (`hello` capability `efforts`); the effort pill needs it too. */
		effortsSupported?: boolean;
		/** Signals the parent to re-read the agent snapshot. The pill labels
		 * are the snapshot's, so a switch is only claimed once the daemon has
		 * confirmed it in a fresh read — the same discipline as the tree's
		 * "never an optimistic splice". */
		onchanged: () => void;
		/** After the permission selector changed the machine's setting: the
		 * parent re-reads the snapshot and the rules (the note and the
		 * exceptions come from them). Falls back to `onchanged`. */
		onpermissionchanged?: () => void;
		/** Opens the re-enroll dialog — the same pointer the sidebar's pill
		 * offers, reached here because the composer is where the dead send
		 * would otherwise be discovered. */
		onreenroll?: () => void;
		/** The latest usage/compaction side-channel frames (M3), tracked by
		 * the view's own fold — null until the first one arrives. */
		usage?: AgentUsageUpdate["usage"] | null;
		lastCompaction?: AgentCompactionUpdate | null;
		/** The two option lists, live from the daemon for the agent's
		 * provider — fetched by the view (whose effects re-run when the
		 * device row lands; the composer's own effects proved unreliable
		 * under hydration, which the e2e caught). Null = still loading; a
		 * failure arrives as the failure string beside it. */
		modes?: CodeProviderMode[] | null;
		modesFailure?: string | null;
		models?: CodeProviderModel[] | null;
		modelsFailure?: string | null;
		/** Models the machine listed but its enrollment policy keeps off the
		 * panel. */
		modelsHidden?: number;
		/** Whether the backend advertised the `usage` capability in `hello` —
		 * the meter renders nothing at all when it did not. */
		usageSupported?: boolean;
		/** Whether the backend can compact on request (`hello` capability
		 * `compact`) — the `/compact` command needs it; ContextMeter's own
		 * "Compact now" hides without it too. */
		compactSupported?: boolean;
		/** Whether the backend can roll a session back (`hello` capability
		 * `revert`) — `/undo` and `/redo` need it. */
		revertSupported?: boolean;
		/** Whether the backend folds a prompt sent mid-turn into the running
		 * turn (`hello` capability `steer`): Send stays beside Stop and the
		 * "Stop and send" chevron shows only then. Without it the stop
		 * control stands alone, as it did before steering. */
		steerSupported?: boolean;
		/** Opens the rollback confirmation for `/undo` — the view owns it,
		 * because only the transcript knows the last user message's machine
		 * id and carries the same confirm dialog the retry action uses. */
		onundo?: () => void;
		/** Opens the new-agent dialog on this agent's workspace — the view
		 * owns the workspace object the dialog needs. */
		onnew?: () => void;
	}

	let {
		deviceId,
		agentId,
		agent,
		ceiling = {},
		running = false,
		enrollmentExpired = false,
		offline = false,
		onsend,
		mimeTypes = [],
		onstop,
		onchanged,
		onpermissionchanged,
		onreenroll,
		usage = null,
		lastCompaction = null,
		usageSupported = false,
		modes = null,
		modesFailure = null,
		models = null,
		modelsFailure = null,
		modelsHidden = 0,
		compactSupported = false,
		revertSupported = false,
		steerSupported = false,
		onundo,
		onnew,

		effortsSupported = false,
	}: Props = $props();

	let draft = $state("");
	let files = $state<File[]>([]);
	let focused = $state(false);
	let busy = $state(false);

	// Unsent-text persistence: one draft per device+agent, kept on this
	// device only. The view remounts per address, so returning to an agent
	// restores whatever was typed there; a landed send clears it, a refused
	// one keeps it (only the success paths empty the draft below).
	let draftKey = $derived(codeDraftKey(deviceId, agentId));

	async function submit() {
		if (enrollmentExpired || offline) return;
		const message = draft.trim();
		if (!message || busy) return;
		// A draft that names a command — panel or the machine's own — runs it
		// instead of posting a message. The ChatInput Enter path parses the
		// same rule and calls onslashcommand directly (below), so this
		// re-parse is only reached by the send button's own form submit —
		// either way one parse runs.
		const run = matchSlashCommand(message, allCommands);
		if (run) {
			if (running) {
				// A prompt steers a running turn; a command must not join it
				// half-explained, so it waits for the turn or for a stop.
				errorToast.set("The agent is mid-turn. Stop it, or wait for it to finish.");
				return;
			}
			busy = true;
			try {
				const ran = await runCommand(run);
				// A command deferred to the confirmation sheet keeps its draft.
				if (ran) {
					draft = "";
					files = [];
				}
			} finally {
				busy = false;
			}
			return;
		}
		busy = true;
		try {
			await onsend(message, files);
			// Cleared only on a landed send: a refused follow-up keeps its text
			// and its files, like every composer here.
			draft = "";
			files = [];
		} finally {
			busy = false;
		}
	}

	/** "Stop and send": end the live turn, then send the draft as the next
	 * turn's prompt. A stop the daemon refused sends nothing and keeps the
	 * draft — the stop's own failure is already on the view's banner. */
	async function stopAndSend() {
		if (enrollmentExpired || offline || busy) return;
		const message = draft.trim();
		if (!message) return;
		if (matchSlashCommand(message, allCommands)) {
			errorToast.set("The agent is mid-turn. Stop it, or wait for it to finish.");
			return;
		}
		busy = true;
		try {
			if ((await onstop?.()) === false) return;
			await onsend(message, files);
			draft = "";
			files = [];
		} finally {
			busy = false;
		}
	}

	/** The one panel command run, shared by the Enter path (ChatInput's
	 * `onslashcommand`) and the send button's own form submit. */
	async function onSlashCommand(command: SlashCommand, args: string) {
		if (enrollmentExpired || offline || busy) return;
		if (running) {
			errorToast.set("The agent is mid-turn. Stop it, or wait for it to finish.");
			return;
		}
		busy = true;
		try {
			const ran = await runCommand({ command, args });
			// A command deferred to the confirmation sheet keeps its draft —
			// the sheet's own run (or a Cancel) decides what happens next.
			if (ran) {
				draft = "";
				files = [];
			}
		} finally {
			busy = false;
		}
	}

	/** Run one `/` command: a panel command over its existing route, a
	 * backend command through the confirmation gate and `session.command`.
	 * Returns whether the run actually went out — a command held by the
	 * confirmation sheet did not, and the caller keeps its draft. A failure
	 * lands in a toast; the refusal keeps the text to retry. */
	async function runBackendCommand(command: SlashCommand, args: string): Promise<boolean> {
		const full = backendCommands.find((candidate) => candidate.name === command.name);
		if (!full) {
			errorToast.set("That command is no longer listed on this machine.");
			return true;
		}
		// A project-origin or shell-expanding command asks once per (device,
		// name, templateHash) before its first run — the sheet is a speed
		// bump, the machine's commandShell policy the real veto.
		if (
			(full.origin === "project" || full.shell === true) &&
			confirmedHash(full) !== (full.templateHash ?? "")
		) {
			confirming = { command: full, args };
			return false;
		}
		await executeBackendCommand(full, args);
		return true;
	}

	async function executeBackendCommand(full: CodeCommand, args: string) {
		try {
			await runAgentCommand(deviceId, agentId, {
				name: full.name,
				arguments: args,
				...(full.templateHash ? { templateHash: full.templateHash } : {}),
			});
			// The template a refused run described may have changed since the
			// menu was filled; re-read so the next open is current.
			void refreshBackendCommands();
		} catch (err) {
			if (err instanceof CodeApiError && err.status === 409) {
				errorToast.set("This command changed on the machine; review it again.");
			} else if (err instanceof Error) {
				errorToast.set(err.message);
			} else {
				errorToast.set("The daemon refused the command.");
			}
		}
	}

	async function confirmBackendCommand() {
		const pending = confirming;
		if (!pending) return;
		rememberConfirmation(pending.command);
		await executeBackendCommand(pending.command, pending.args);
		confirming = null;
	}

	async function refreshBackendCommands() {
		const token = ++commandsToken;
		try {
			const result = await listAgentCommands(deviceId, agentId);
			if (token === commandsToken) backendCommands = result.commands;
		} catch {
			if (token === commandsToken) backendCommands = [];
		}
	}

	async function runCommand({
		command,
		args,
	}: {
		command: SlashCommand;
		args: string;
	}): Promise<boolean> {
		if (command.group !== "panel") return runBackendCommand(command, args);
		switch (command.name) {
			case "compact": {
				try {
					await compactAgent(deviceId, agentId);
					onchanged();
				} catch (err) {
					if (err instanceof CodeApiError && err.status === 404) {
						errorToast.set("This backend cannot compact on request.");
					} else {
						errorToast.set(err instanceof Error ? err.message : "The daemon refused to compact.");
					}
				}
				return true;
			}
			case "undo":
				// The confirmation — and the machine id it needs — live in the
				// view, the same dialog the transcript's retry action uses.
				onundo?.();
				return true;
			case "redo": {
				try {
					await unrevertAgent(deviceId, agentId);
					onchanged();
				} catch (err) {
					errorToast.set(
						err instanceof Error ? err.message : "The daemon refused to undo the rollback."
					);
				}
				return true;
			}
			case "model": {
				// No argument: open the picker. An argument: the unique fuzzy
				// match applies outright; anything else opens the picker for a
				// proper search rather than guessing between near-misses.
				const query = args.toLowerCase();
				if (!query) {
					modelPickerOpen = true;
					return true;
				}
				const matches = (models ?? []).filter(
					(model) =>
						model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query)
				);
				if (matches.length === 1) {
					rememberCodeModel(matches[0].id);
					await applyModel(matches[0].id);
				} else {
					modelPickerOpen = true;
				}
				return true;
			}
			case "mode": {
				const query = args.toLowerCase();
				if (!query) {
					modeMenuOpen = true;
					return true;
				}
				const matches = (modes ?? []).filter(
					(mode) =>
						mode.id.toLowerCase().includes(query) || mode.label.toLowerCase().includes(query)
				);
				if (matches.length === 1) {
					await applyMode(matches[0].id);
				} else {
					modeMenuOpen = true;
				}
				return true;
			}
			case "effort": {
				const query = args.toLowerCase();
				const levels = effortLevels ?? [];
				if (!query) {
					modelPickerOpen = true;
					return true;
				}
				const matches = levels.filter((level) => level.toLowerCase().includes(query));
				if (matches.length === 1) {
					await applyEffort(matches[0]);
				} else {
					modelPickerOpen = true;
				}
				return true;
			}
			case "new":
				onnew?.();
				return true;
			default:
				return true;
		}
	}

	// The panel commands the `/` menu lists, gated on what this agent's
	// backend reports — the table itself lives in slashCommand.svelte.ts,
	// where it is tested.
	let panelCommands = $derived.by(() => {
		return panelCommandTable({
			compact: compactSupported,
			revert: revertSupported,
			efforts: effortsSupported,
		});
	});

	// The menu's backend half: the machine's own command list, fetched once
	// per open agent (and again after each backend run — the template a
	// failed run described may have changed). A machine without the
	// capability (an old galopin: the op 404s) leaves the list empty and
	// the menu panel-only, exactly what batch B already handles.
	let backendCommands = $state<CodeCommand[]>([]);
	let commandsToken = 0;
	$effect(() => {
		const token = ++commandsToken;
		backendCommands = [];
		untrack(async () => {
			try {
				const result = await listAgentCommands(deviceId, agentId);
				if (token === commandsToken) backendCommands = result.commands;
			} catch {
				// Silent fallback by design: the menu is the help, and a
				// machine that cannot answer it still runs every panel
				// command. The refusal that matters comes at run time.
				if (token === commandsToken) backendCommands = [];
			}
		});
	});

	/** The machine's commands mapped into the menu's shape: the group from
	 * the origin (project commands are repo code — the badge says so), the
	 * hint from the template's own placeholders, and a panel-name collision
	 * marked shadowed rather than dropped, so the menu explains the rule it
	 * enforces instead of silently hiding half of it. */
	let allCommands = $derived.by(() => {
		// Read the agent prop directly: the device-row flip that turns the
		// capability gates on arrives with the snapshot, and this derived
		// must re-evaluate on THAT flip, not only on its own inputs'
		// intermediates (the e2e caught the menu staying stale otherwise).
		void agent?.provider;
		const panel = panelCommandTable({
			compact: compactSupported,
			revert: revertSupported,
			efforts: effortsSupported,
		});
		const panelNames = new Set(panel.concat(panelCommands).map((c) => c.name.toLowerCase()));
		const backend = backendCommands.map((command) => {
			const slash: SlashCommand = {
				name: command.name,
				description: command.description ?? "",
				hint: command.hints.length ? command.hints.join(" ") : undefined,
				group:
					command.source === "mcp"
						? "mcp"
						: command.source === "skill"
							? "skill"
							: command.origin === "project"
								? "project"
								: "machine",
				shell: command.shell === true,
			};
			if (panelNames.has(command.name.toLowerCase())) slash.shadowed = true;
			return slash;
		});
		return [...panel, ...backend];
	});

	/** The command the confirmation sheet is open for: a project-origin or
	 * shell-expanding command whose (name, templateHash) this device has
	 * not confirmed yet. Everything else runs straight away. */
	let confirming = $state<{ command: CodeCommand; args: string } | null>(null);
	const CONFIRMED_KEY = "code:command-confirmations:";

	function confirmedHash(command: CodeCommand): string | undefined {
		try {
			const stored = JSON.parse(globalThis.localStorage?.getItem(CONFIRMED_KEY + deviceId) ?? "{}");
			return stored[command.name];
		} catch {
			return undefined;
		}
	}

	function rememberConfirmation(command: CodeCommand) {
		try {
			const key = CONFIRMED_KEY + deviceId;
			const stored = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}");
			stored[command.name] = command.templateHash ?? "";
			globalThis.localStorage?.setItem(key, JSON.stringify(stored));
		} catch {
			// Storage unavailable (private mode): the confirmation simply
			// re-asks next run — a speed bump, not a correctness problem.
		}
	}

	// One switch in flight at a time; a refusal lands here and the pill
	// shows it, since the snapshot it labels from never changed.
	let applying = $state<string | null>(null);
	let applyFailure = $state<string | null>(null);

	async function applyMode(modeId: string) {
		if (applying || modeId === (agent?.modeId ?? null)) return;
		applying = "mode";
		applyFailure = null;
		try {
			const result = await setAgentMode(deviceId, agentId, modeId);
			if (result.notice) applyFailure = result.notice;
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the mode.";
		} finally {
			applying = null;
		}
	}

	async function applyModel(modelId: string) {
		if (applying || modelId === (agent?.modelId ?? null)) return;
		applying = "model";
		applyFailure = null;
		try {
			await setAgentModel(deviceId, agentId, modelId);
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the model.";
		} finally {
			applying = null;
		}
	}

	/** Set the session's blanket. Not optimistic: the selector shows the
	 * snapshot's word, so a click is only claimed once the parent has re-read
	 * the machine and it agrees. A refusal (a subagent, an unknown session)
	 * lands in the same failure line as the other pills'. */
	async function applyPermissionMode(mode: PermissionMode) {
		if (applying || mode === agent?.permissionMode) return;
		applying = "permission";
		applyFailure = null;
		try {
			await setPermissionMode(deviceId, agentId, mode);
			(onpermissionchanged ?? onchanged)();
		} catch (err) {
			applyFailure =
				err instanceof Error ? err.message : "The machine refused the permission setting.";
		} finally {
			applying = null;
		}
	}

	/** The selector draws only with the machine's word to show (an older
	 * galopin has no `permissionMode`), and never on a stale sign-in: the
	 * server refuses the call anyway. */
	const PERMISSION_SEGMENTS: Array<{ mode: PermissionMode; label: string; title: string }> = [
		{
			mode: "deny",
			label: "Deny",
			title:
				"Edits, commands and fetches are refused without asking. Reading still works. Your exceptions are kept, but blocked.",
		},
		{
			mode: "ask",
			label: "Ask",
			title:
				"Edits, commands and fetches ask first. Reading is allowed. Your exceptions for this session run without asking.",
		},
		{
			mode: "allow",
			label: "Allow",
			title:
				"Edits, commands and fetches run without asking, up to this machine's limits. Still asks: writing outside the project folder, and an agent that is stuck repeating itself.",
		},
	];
	let isSubagent = $derived(Boolean(agent?.parentId));
	let permissionMode = $derived(agent?.permissionMode ?? null);
	let showPermissionSelector = $derived(permissionMode !== null && !codeReauth.required);
	/** Under Allow, what this machine's ceiling still holds back. */
	let permissionNote = $derived.by(() => {
		if (isSubagent) return "Follows the main session";
		if (permissionMode !== "allow") return "";
		const held = ceilingNote(ceiling);
		return held ? `Allow · ${held} (machine limit)` : "";
	});

	let modeLabel = $derived.by(() => {
		if (!agent?.modeId) return "Mode";
		return modes?.find((mode) => mode.id === (agent?.modeId ?? null))?.label ?? agent.modeId;
	});
	/** The model the agent runs: its explicit one, else the backend's
	 * default, so the pill names a real model rather than saying "Model".
	 * The same resolution the picker's checkmark uses (below), so the two
	 * never disagree on which row is active. */
	let currentModel = $derived(resolveActiveModel(agent?.modelId, models));
	let modelLabel = $derived.by(() => {
		if (agent?.modelId) return currentModel?.label ?? agent.modelId;
		return currentModel?.label ?? "Model";
	});

	/** The effort submenu inside the model/effort pill: only for a backend
	 * that takes one and a model with levels — the same guard the old
	 * standalone Effort pill used, now feeding `ModelEffortPicker`'s
	 * `efforts` prop instead of a pill of its own. */
	let effortLevels = $derived(
		effortsSupported && currentModel?.efforts?.length ? currentModel.efforts : null
	);

	// The shared model/effort pill (`ModelEffortPicker.svelte`, the chat
	// composer's own): the daemon's model list adapted to the picker's
	// `PickerModel` shape (no logo — the /code catalog carries none), and a
	// /code-only recency memory so the short list favours what this device's
	// person actually picks, separate from chat's (`readRecent`/`withRecent`
	// are the pure parts the pill's own utils module keeps, not chat-only).
	let pickerModels = $derived<PickerModel[]>(
		(models ?? []).map((model) => ({
			id: model.id,
			name: model.label,
			description: model.description,
		}))
	);
	let codeRecentIds = $state<string[]>([]);
	$effect(() => {
		codeRecentIds = readRecent(globalThis.localStorage, CODE_RECENT_MODELS_KEY);
	});
	function rememberCodeModel(id: string) {
		codeRecentIds = withRecent(codeRecentIds, id);
		globalThis.localStorage?.setItem(CODE_RECENT_MODELS_KEY, JSON.stringify(codeRecentIds));
	}
	/** "More models": the full searchable dialog (`ModelPickerDialog`, shared
	 * with chat's own "More models"), for a catalog longer than the pill's
	 * six-row short list. */
	let modelDialogOpen = $state(false);
	/** The picker's popover, bindable from the component — `/model` (and
	 * `/effort`) with no argument opens it instead of guessing a choice. */
	let modelPickerOpen = $state(false);
	/** The mode pill's menu, same reason: `/mode` with no argument opens it. */
	let modeMenuOpen = $state(false);

	// Below `sm` the pill row is one nowrap, scrolling line, and the layout
	// (the ring's width, which of two rows carries the model picker) follows.
	const narrowViewport = new MediaQuery("(max-width: 639px)");

	async function applyEffort(effort: string | null) {
		if (applying || effort === (agent?.effort ?? null)) return;
		applying = "effort";
		applyFailure = null;
		try {
			await setAgentEffort(deviceId, agentId, effort);
			onchanged();
		} catch (err) {
			applyFailure = err instanceof Error ? err.message : "The daemon refused the effort.";
		} finally {
			applying = null;
		}
	}

	// The chat composer's own pill classes, always in the blue tone: these
	// are pickers showing what the agent is set to, not toggles of state.
	// Mobile shrinks height, padding and gap (max-sm:) so four-plus pills fit
	// one unwrapped, horizontally-scrolling row under 390px; sm and up is
	// unchanged from before this pass.
	const pillClass =
		"flex h-7 max-sm:h-6 flex-none items-center gap-1 max-sm:gap-0.5 rounded-full border px-2.5 max-sm:px-1.5 text-xs font-medium transition-colors border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300 disabled:opacity-60";
	const chevronClass = "size-3 max-sm:size-2.5 opacity-70";
	const menuContentClass =
		"z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100";
	const menuItemClass =
		"flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10";
	const menuNoteClass =
		"flex h-9 items-center rounded-md px-2 text-sm text-gray-500 select-none sm:h-8 dark:text-gray-400";
</script>

<form
	tabindex="-1"
	onsubmit={(e) => {
		e.preventDefault();
		void submit();
	}}
	class={{
		"relative flex w-full max-w-4xl flex-1 flex-col rounded-xl border bg-gray-100 dark:border-gray-700 dark:bg-gray-800": true,
		"max-sm:mb-4": focused && isVirtualKeyboard(),
	}}
	style:--composer-actions-width={narrowViewport.current ? "44px" : "120px"}
>
	<!-- The pill row's own width cap (ChatInput.svelte) reserves this much
	     for whatever trailingActions renders. 44px covered the ring alone
	     (mobile: send is pinned outside this row entirely, unaffected by
	     the cap). Desktop's trailingActions now also carries the send
	     control (item 2), which the old 44px left too little room for — the
	     pill row could grow wide enough to sit under it, which is exactly
	     what stranded the explorer's Send button under an open file panel
	     until this was widened. -->
	<div class="flex w-full items-center">
		<div class="flex w-full flex-1 rounded-xl border-none bg-transparent">
			<ComposerFileChips bind:files />
			<ChatInput
				placeholder="Follow up with the agent…"
				bind:value={draft}
				{draftKey}
				{mimeTypes}
				chatTools={false}
				bind:files
				onsubmit={submit}
				bind:focused
				slashCommands={allCommands}
				onslashcommand={onSlashCommand}
			>
				{#snippet children()}
					<!-- Only the state that belongs *in* the prompt box renders here:
				     the mode pill, the permission selector and the status banners.
				     Below `sm` the toolbar row goes nowrap-and-scroll, with the
				     `+` before it and the ring after it pinned outside it, so
				     none of those scroll away. The model/effort control moved
				     to its own row below the form, like the regular chat's
				     model/effort line; the mode (build/plan) pill stays here —
				     a session toggle beside the toggles, not a trailing
				     readout. -->
					<DropdownMenu.Root bind:open={modeMenuOpen}>
						<DropdownMenu.Trigger
							class={pillClass}
							disabled={applying === "mode"}
							title="How much the agent may do on its own — the machine's modes, as the backend defines them"
						>
							<span class="max-sm:max-w-12 max-sm:truncate">{modeLabel}</span>
							<IconChevronDown class={chevronClass} />
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								class={menuContentClass}
								side="top"
								align="start"
								sideOffset={8}
								trapFocus={false}
								onCloseAutoFocus={(e) => e.preventDefault()}
								interactOutsideBehavior="defer-otherwise-close"
							>
								{#if modes === null && !modesFailure}
									<DropdownMenu.Item class={menuNoteClass} disabled
										>Loading modes…</DropdownMenu.Item
									>
								{:else if modesFailure}
									<DropdownMenu.Item class={menuNoteClass} disabled>
										Could not load modes: {modesFailure}
									</DropdownMenu.Item>
								{:else if !modes?.length}
									<DropdownMenu.Item class={menuNoteClass} disabled>
										The daemon lists no modes.
									</DropdownMenu.Item>
								{:else}
									{#each modes as mode (mode.id)}
										<DropdownMenu.Item
											class={menuItemClass}
											onSelect={() => void applyMode(mode.id)}
										>
											<IconCheck
												class="size-3.5 shrink-0 {mode.id === (agent?.modeId ?? null)
													? 'opacity-100'
													: 'opacity-0'}"
											/>
											<span class="whitespace-nowrap" title={mode.description}>
												{mode.label}
											</span>
										</DropdownMenu.Item>
									{/each}
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
					<!-- The permission selector: the session's blanket, Deny · Ask ·
					     Allow. The value is the agent snapshot's word, so a click
					     waits for the machine's answer rather than guessing. On a
					     subagent it is disabled and says whose it follows; under
					     Allow, the note names what the ceiling still caps. Below
					     `sm` the note drops out of the one-line row (the Allow
					     segment's title carries the same facts). -->
					{#if showPermissionSelector}
						<div
							role="radiogroup"
							aria-label="Permission for this session"
							aria-busy={applying === "permission"}
							data-testid="permission-mode"
							data-mode={permissionMode}
							title={isSubagent
								? "A subagent follows the main session's permission setting."
								: "What this session does about a tool call it has no rule for."}
							class="flex h-7 flex-none items-center rounded-full border border-blue-600/30 bg-blue-50/60 p-0.5 text-xs font-medium max-sm:h-6 dark:border-blue-700/60 dark:bg-blue-900/20"
						>
							{#each PERMISSION_SEGMENTS as segment (segment.mode)}
								<button
									type="button"
									role="radio"
									aria-checked={permissionMode === segment.mode}
									disabled={isSubagent || applying !== null}
									title={segment.title}
									data-testid="permission-mode-{segment.mode}"
									onclick={() => void applyPermissionMode(segment.mode)}
									class={[
										"h-full rounded-full px-2.5 transition-colors disabled:cursor-default max-sm:px-1.5",
										permissionMode === segment.mode
											? "bg-blue-100 text-blue-700 dark:bg-blue-800/60 dark:text-blue-200"
											: "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
										(isSubagent || applying !== null) && permissionMode !== segment.mode
											? "opacity-60"
											: "",
									]}
								>
									{segment.label}
								</button>
							{/each}
						</div>
						{#if permissionNote}
							<span
								class="flex min-w-0 flex-none items-center gap-1 text-xs text-gray-500 max-sm:hidden dark:text-gray-400"
								data-testid="permission-mode-note"
								title={permissionNote}
							>
								{permissionNote}
							</span>
						{/if}
					{/if}

					{#if applyFailure}
						<span
							class="flex min-w-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
						>
							<IconWarning class="size-3 shrink-0" />
							<span class="min-w-0 truncate" title={applyFailure}>{applyFailure}</span>
						</span>
					{/if}

					{#if offline}
						<span class="flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
							<IconWarning class="size-3 shrink-0" />
							<span class="min-w-0 truncate">This machine is offline.</span>
						</span>
					{:else if enrollmentExpired}
						<span class="flex min-w-0 items-center gap-1 text-xs text-red-600 dark:text-red-400">
							<IconWarning class="size-3 shrink-0" />
							<span class="min-w-0 truncate">
								This machine's enrollment expired or was revoked.
							</span>
							<button
								type="button"
								class="shrink-0 font-medium underline underline-offset-2"
								onclick={() => onreenroll?.()}
							>
								Re-enroll
							</button>
						</span>
					{/if}
				{/snippet}
				{#snippet trailingActions()}
					<!-- Desktop's send/stop control (`sendControl`, below) sits
					     after the pill group, in this same row, rather than
					     floating absolutely over the composer — see that
					     snippet's comment for why. The usage ring moved to the
					     mode/model/effort row below the form, trailing it right
					     the way chat's trailing actions clear its model line. -->
					{#if !narrowViewport.current}
						{@render sendControl(false)}
					{/if}
				{/snippet}
			</ChatInput>
			<!-- Mobile keeps the send/stop control pinned over the composer's
			     bottom-right corner, exactly as `fix/mobile-composer` left it.
			     Desktop instead renders it inside `trailingActions`, above,
			     right after the ring: pinning it here worked only by
			     coincidence, when the pill row and any banner beneath it
			     (the machine-veto banner, `basis-full`-wrapped) happened to
			     add up to the exact height this button's `bottom-2` expected.
			     Anything that changed that height — a longer pill list
			     wrapping to a second row, the banner appearing — left this
			     corner-pinned button stranded below the row it was meant to
			     share (brief item 2). `narrowViewport` picks exactly one of
			     the two: never both, so there is only ever one "Send
			     message"/stop control in the accessibility tree. -->
			{#if narrowViewport.current}
				{@render sendControl(true)}
			{/if}
		</div>
	</div>
</form>

<!-- The mode/model/effort row, BELOW the composer like the regular chat's
     model/effort row (`ChatWindow`'s `mt-1.5` line under its form): the
     model/effort control renders exactly as chat's does — the shared
     component's own default trigger, quiet gray underline-text, no pill
     border. The usage ring trails the row right — chat's own layout keeps
     trailing actions out of the pill row's flow, and the ring is the agent
     row's trailing action, not another pill. The mode (build/plan) pill
     lives back inside the composer's pill row with the permission selector:
     it is a session toggle like they are, not a trailing readout.
     Outside ChatInput's scrollable toolbar row, so on mobile nothing
     masks any of it. -->
<div
	class="mt-1.5 flex h-5 flex-wrap items-center gap-1.5 self-stretch px-0.5 text-xs whitespace-nowrap text-gray-400/90 max-md:mb-2"
>
	<!-- The model/effort pill: the chat composer's own `ModelEffortPicker`,
	     rendered exactly as chat renders it below its composer — the
	     component's own default trigger (underline-text, no pill border,
	     `· effort ⌄`), with "Model:" and the model's name as its content.
	     The daemon's loading and failure states keep the quiet-text look
	     too. Only the machine-policy footer differs from chat's. -->
	{#if models === null && !modelsFailure}
		<span class="text-xs whitespace-nowrap text-gray-400/90 opacity-60"> Loading models… </span>
	{:else if modelsFailure}
		<span class="text-xs whitespace-nowrap text-gray-400/90 opacity-60" title={modelsFailure}>
			Could not load models
		</span>
	{:else if !models?.length}
		<span class="text-xs whitespace-nowrap text-gray-400/90 opacity-60">
			The daemon lists no models.
		</span>
	{:else}
		<ModelEffortPicker
			bind:open={modelPickerOpen}
			models={pickerModels}
			currentId={currentModel?.id ?? agent?.modelId ?? ""}
			recentIds={codeRecentIds}
			efforts={effortLevels}
			effort={agent?.effort ?? undefined}
			onpickModel={(id) => {
				rememberCodeModel(id);
				void applyModel(id);
			}}
			onpickEffort={(level) => void applyEffort(level ?? null)}
			onmore={() => (modelDialogOpen = true)}
			disabled={applying === "model" || applying === "effort"}
		>
			<span class="shrink-0">Model:</span>
			<span class="truncate" title={modelLabel}>{modelLabel}</span>
			{#snippet footer()}
				{#if modelsHidden > 0}
					<div class={menuNoteClass}>
						{modelsHidden} non-gateway {modelsHidden === 1 ? "model" : "models"} hidden: this machine
						was enrolled without --allow-free-models.
					</div>
				{/if}
			{/snippet}
		</ModelEffortPicker>
	{/if}

	<!-- The usage ring, trailing the row: pinned right with `ml-auto`, out
	     of the pill flow, exactly the way chat's trailing actions sit clear
	     of its model/effort line. On mobile it shows only the ring — the
	     value and quotas stay in its own popup. -->
	<span class="ml-auto flex flex-none items-center">
		<ContextMeter
			{deviceId}
			{agentId}
			{usage}
			{lastCompaction}
			supported={usageSupported}
			{running}
			{onchanged}
		/>
	</span>
</div>

{#if modelDialogOpen}
	<ModelPickerDialog
		models={pickerModels}
		currentId={currentModel?.id ?? agent?.modelId ?? ""}
		title="Switch model"
		subtitle="Changes this agent only."
		onchoose={(id) => {
			modelDialogOpen = false;
			rememberCodeModel(id);
			void applyModel(id);
		}}
		onclose={() => (modelDialogOpen = false)}
	/>
{/if}

{#if confirming}
	<!-- The first-run confirmation for a project or shell command: the
	     snippets and file refs the machine's listing carried, the accept
	     remembered per device in localStorage. -->
	<CommandConfirmSheet
		command={confirming.command}
		onconfirm={() => confirmBackendCommand()}
		onclose={() => (confirming = null)}
	/>
{/if}

{#snippet sendControl(pinned: boolean)}
	<!-- One cluster, pinned or inline: while a turn runs it is stop, then
	     send (a steer) with its "Stop and send" chevron; otherwise send alone.
	     Pinned (mobile) the cluster is what floats over the corner, so the
	     buttons stay together at the width of a thumb. -->
	<span
		class="{pinned ? 'absolute right-2 bottom-2' : ''} flex flex-none items-end gap-1.5 self-end"
	>
		{#if running}
			<!-- The stop control, exactly where chat's sits: ChatWindow swaps the
			     send button for StopGeneratingBtn in this same spot while a turn
			     is live. It stays while a permission card is up — stopping a
			     prompt nobody wants to answer is the point of it — and the
			     turn's end comes from the transcript's stream, not from this
			     click. -->
			<StopGeneratingBtn
				onClick={onstop}
				showBorder={true}
				classNames="{pinned
					? 'size-8'
					: 'size-7'} self-end rounded-full border bg-white text-black shadow-sm transition-none dark:border-transparent dark:bg-gray-600 dark:text-white"
			/>
		{/if}
		{#if !running || steerSupported}
			<span class="flex items-end">
				<button
					class="{pinned
						? 'size-8'
						: 'size-7'} btn self-end border bg-white text-black shadow transition-none enabled:hover:bg-white enabled:hover:shadow-inner dark:border-transparent dark:bg-gray-600 dark:text-white dark:hover:enabled:bg-black {running
						? 'rounded-l-full rounded-r-none'
						: 'rounded-full'} {!draft
						? ''
						: 'bg-black! text-white! dark:bg-white! dark:text-black!'}"
					disabled={!draft.trim() || busy || enrollmentExpired || offline}
					type="submit"
					aria-label="Send message"
					title={running ? "Send to the running turn" : undefined}
					name="submit"
				>
					<IconArrowUp />
				</button>
				{#if running}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="btn {pinned
								? 'h-8'
								: 'h-7'} w-5 flex-none self-end rounded-l-none rounded-r-full border border-l-0 bg-white px-0 text-black shadow transition-none enabled:hover:bg-white enabled:hover:shadow-inner dark:border-transparent dark:bg-gray-600 dark:text-white dark:hover:enabled:bg-black {!draft
								? ''
								: 'bg-black! text-white! dark:bg-white! dark:text-black!'}"
							disabled={!draft.trim() || busy || enrollmentExpired || offline}
							aria-label="More ways to send"
						>
							<IconChevronDown class="size-3" />
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								class={menuContentClass}
								side="top"
								align="end"
								sideOffset={8}
								trapFocus={false}
								onCloseAutoFocus={(e) => e.preventDefault()}
								interactOutsideBehavior="defer-otherwise-close"
							>
								<DropdownMenu.Item class={menuItemClass} onSelect={() => void stopAndSend()}>
									<span class="whitespace-nowrap">Stop and send</span>
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				{/if}
			</span>
		{/if}
	</span>
{/snippet}
