/**
 * The `/` autocomplete's state machine, kept out of `ChatInput` so it can be
 * tested directly — the same split `hubMention.svelte.ts` uses for the `@`
 * menu it mirrors. No debounce and no network: it filters the list it is
 * given, synchronously, by prefix first and then substring.
 *
 * The panel is open exactly when the draft starts with `/` and the caret is
 * inside the first token; `//` at the very start escapes to a literal slash
 * and never opens it. Batch B lists Panel commands only — the group field is
 * the shape batch C's backend command groups (project/machine/skill/mcp)
 * slot into without reshaping this file.
 */

/** The groups the menu renders, in this order, one heading per present group. */
export type SlashCommandGroup = "panel" | "project" | "machine" | "skill" | "mcp";

export interface SlashCommand {
	/** The name after the slash, matched case-insensitively. */
	name: string;
	description: string;
	/** Placeholder hint rendered as ghost text after accept (`/model [model]`). */
	hint?: string;
	group: SlashCommandGroup;
	/** Marks a command that expands a shell snippet — the menu marks these
	 * rows with a shell icon, and the confirmation sheet shows the snippets
	 * before a first run. */
	shell?: boolean;
	/** A backend command whose name a panel command reserved: rendered
	 * greyed with the reason, never selectable — the panel's own wins. */
	shadowed?: boolean;
}

/** The token the menu is completing: the draft's first `/word`. */
export interface SlashToken {
	/** The typed text after the slash, up to the caret. */
	query: string;
	/** Index just past the token — where arguments would begin. */
	end: number;
}

/** A draft whose first token is a known command, parsed for the run. */
export interface SlashRun {
	command: SlashCommand;
	args: string;
}

/** The capability flags the panel command list is gated on — the agent
 * backend's `hello` capabilities (efforts additionally needs the current
 * model to actually carry levels). */
export interface PanelCommandFlags {
	compact: boolean;
	revert: boolean;
	efforts: boolean;
}

/**
 * The panel commands the `/` menu lists: only what this agent's backend can
 * actually do — compact and rollback gated on their `hello` capabilities,
 * effort on the model's levels — and nothing more. Panel names are
 * reserved; batch C's backend commands will shadow against this list, not
 * extend it.
 */
export function panelCommands(flags: PanelCommandFlags): SlashCommand[] {
	return [
		...(flags.compact
			? [{ name: "compact", description: "Compact the conversation now", group: "panel" as const }]
			: []),
		...(flags.revert
			? [
					{
						name: "undo",
						description: "Roll back to before the last prompt",
						group: "panel" as const,
					},
					{ name: "redo", description: "Undo the last rollback", group: "panel" as const },
				]
			: []),
		{
			name: "model",
			description: "Switch the model the agent runs",
			hint: "[model]",
			group: "panel" as const,
		},
		{
			name: "mode",
			description: "Switch the agent's mode",
			hint: "[mode]",
			group: "panel" as const,
		},
		...(flags.efforts
			? [
					{
						name: "effort",
						description: "Set the thinking effort",
						hint: "[level]",
						group: "panel" as const,
					},
				]
			: []),
		{ name: "new", description: "Start a new agent on this workspace", group: "panel" as const },
	];
}

/**
 * The submit rule: a draft shaped `/name args…` whose name is a known
 * command RUNS it; anything else — including `/etc/hosts is wrong` and the
 * `//` escape — is sent as ordinary text. Matches the raw draft (no leading
 * trim): a draft the menu would not have opened for does not run either.
 */
const SLASH_RUN_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/;

export function matchSlashCommand(value: string, commands: SlashCommand[]): SlashRun | null {
	const match = SLASH_RUN_RE.exec(value);
	if (!match) return null;
	const name = (match[1] ?? "").toLowerCase();
	const command = commands.find((candidate) => candidate.name.toLowerCase() === name);
	if (!command) return null;
	return { command, args: (match[2] ?? "").trim() };
}

/** The draft's first `/word`, or null when the menu must not open. */
function findSlashToken(value: string, caret: number): SlashToken | null {
	if (!value.startsWith("/") || value.startsWith("//")) return null;
	let end = value.length;
	for (let i = 0; i < value.length; i += 1) {
		if (/\s/.test(value[i] ?? "")) {
			end = i;
			break;
		}
	}
	// Inside the first token only: once the caret crosses the space (or the
	// token's end) the command word is settled and the menu has no business
	// completing it.
	if (caret > end) return null;
	return { query: value.slice(1, Math.min(caret, end)), end };
}

export class SlashCommandState {
	token = $state<SlashToken | null>(null);
	/** The filtered list, recomputed whenever the tracked token, the live
	 * command list (read through the getter the component bound), or the
	 * highlight changes — so a list that lands while the menu is open
	 * refreshes it without needing another keystroke. */
	results = $derived.by(() => {
		if (this.token === null) return [];
		return this.#filter(this.token.query, this.#getCommands());
	});
	/**
	 * -1 means "nothing chosen". Enter only accepts once the user has
	 * arrowed into the list, so an ordinary `/word` in prose never swallows
	 * a send — the same precedence the hub mention menu pins.
	 */
	activeIndex = $state(-1);

	#commands: SlashCommand[] = [];
	/** The live list getter, bound once by the component: the menu's results
	 * re-filter against whatever the component's own scope currently holds
	 * (the machine's list can land after the first keystroke). */
	#getCommands: () => SlashCommand[] = () => this.#commands;
	/** The full token text syncValue checks programmatic writes against. */
	#tokenText: string | null = null;
	/**
	 * The query the user dismissed or just accepted. Without it, Escape is
	 * undone by the very next update() — a click back into the same draft
	 * would re-open the panel the user just closed.
	 */
	#suppressed: string | null = null;
	/** The command just accepted, whose hint renders as ghost text. $state so
	 * a derived in the component re-runs when it is set. */
	#accepted = $state<{ name: string; hint: string | null } | null>(null);

	get open(): boolean {
		return this.token !== null;
	}

	/** The result Enter would accept, or undefined when nothing is chosen. */
	get activeResult(): SlashCommand | undefined {
		return this.activeIndex >= 0 ? this.results[this.activeIndex] : undefined;
	}

	setCommands(getCommands: () => SlashCommand[]): void {
		// Bound once; the getter is read reactively by `results`'s derived.
		this.#getCommands = getCommands;
	}

	/**
	 * Re-evaluate against the textarea's current text and caret. Safe to call
	 * from every event that can move the caret; the filter is synchronous, so
	 * results follow the query in the same tick.
	 */
	update(value: string, caret: number | null): void {
		// No commands, no menu — a composer that passes none must not open one
		// on a stray slash, even to say "no matching commands".
		if (this.#getCommands().length === 0) {
			if (this.token !== null) this.reset();
			return;
		}

		// The ghost hint is bound to the exact token it was accepted into;
		// anything else typed retires it.
		if (this.#accepted) {
			const { name } = this.#accepted;
			if (value !== `/${name}` && value !== `/${name} `) this.#accepted = null;
		}

		const next = findSlashToken(value, caret ?? value.length);
		if (!next) {
			if (this.token !== null) this.reset();
			return;
		}
		// A dismissal holds until the query changes — re-entering the same
		// word must not re-open what Escape just closed.
		if (this.#suppressed !== null && next.query === this.#suppressed) {
			this.token = null;
			return;
		}
		this.#suppressed = null;

		this.token = next;
		this.#tokenText = `/${value.slice(1, next.end)}`;
		if (this.activeIndex >= this.results.length) this.activeIndex = -1;
	}

	/**
	 * Close if the draft no longer contains the token being tracked. Covers
	 * every programmatic write the textarea never reports — above all the
	 * composer clearing the draft after a command runs, which would
	 * otherwise leave the panel hovering over an empty input.
	 */
	syncValue(value: string): void {
		const text = this.#tokenText;
		if (!text || this.token === null) return;
		if (value.slice(0, text.length) !== text) this.reset();
	}

	/** Move the highlight, wrapping, and treat the list as explicitly entered. */
	move(delta: number): void {
		if (this.results.length === 0) return;
		const from = this.activeIndex < 0 ? (delta > 0 ? -1 : 0) : this.activeIndex;
		this.activeIndex = (from + delta + this.results.length) % this.results.length;
	}

	setActiveIndex(index: number): void {
		this.activeIndex = index;
	}

	/**
	 * Apply a result to the text: the token becomes `/name ` — the trailing
	 * space is what keeps the accepted word from re-opening the panel at the
	 * next update — and the command's hint, if any, is remembered for the
	 * ghost text that follows. Arguments that already follow the token keep
	 * their own spacing: the separator is not doubled.
	 */
	accept(value: string, command: SlashCommand): { value: string; caret: number } | null {
		if (!this.token) return null;
		const head = `/${command.name}`;
		const rest = value.slice(this.token.end);
		const next =
			rest.length === 0 ? `${head} ` : /^\s/.test(rest) ? `${head}${rest}` : `${head} ${rest}`;
		this.reset();
		this.#accepted = { name: command.name, hint: command.hint ?? null };
		// The caret sits just past the separating space, ready for arguments.
		return { value: next, caret: head.length + 1 };
	}

	/** Escape: close, and stay closed until the query changes. */
	dismiss(): void {
		this.#suppressed = this.token?.query ?? null;
		this.reset();
	}

	reset(): void {
		this.token = null;
		this.#tokenText = null;
		this.activeIndex = -1;
	}

	destroy(): void {
		this.reset();
		this.#suppressed = null;
		this.#accepted = null;
	}

	/**
	 * The ghost hint to render after the accepted token, or null. Lives only
	 * while the draft is exactly what accept left (`/name` or `/name `) —
	 * the first typed argument retires it.
	 */
	ghostHint(value: string): string | null {
		const accepted = this.#accepted;
		if (!accepted?.hint) return null;
		if (value === `/${accepted.name}` || value === `/${accepted.name} `) return accepted.hint;
		return null;
	}

	/** Prefix matches first (in list order), then substring matches. The
	 * list arrives per call — the live one, not a stale copy. */
	#filter(query: string, commands: SlashCommand[]): SlashCommand[] {
		const needle = query.toLowerCase();
		const prefix: SlashCommand[] = [];
		const substring: SlashCommand[] = [];
		for (const command of commands) {
			const name = command.name.toLowerCase();
			if (!needle || name.startsWith(needle)) prefix.push(command);
			else if (name.includes(needle)) substring.push(command);
		}
		return [...prefix, ...substring];
	}
}
