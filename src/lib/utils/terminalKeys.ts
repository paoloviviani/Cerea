/**
 * Which side handles a keyboard event that reaches the terminal: xterm
 * evaluates Ctrl+C and Ctrl+V as control bytes and cancels the DOM event,
 * which suppresses the browser's own copy and paste machinery — so, with no
 * wiring of its own, a web terminal cannot copy on the chord people reach
 * for and cannot paste on Ctrl+V at all. The handler here decides per key
 * whether to step aside (return false without preventDefault, so the
 * browser fires `copy`/`paste`, both of which xterm itself listens for) or
 * to act directly.
 */
export type TerminalKeyAction =
	/** xterm's default: send the byte (Ctrl+C with nothing selected = SIGINT). */
	| "passthrough"
	/** Let the browser's copy event fire; xterm copies its own selection. */
	| "letBrowserCopy"
	/** Let the browser's paste event fire; xterm pastes, bracketed-paste aware. */
	| "letBrowserPaste"
	/** Write the selection to the clipboard here — the copy event never fires
	 * for this chord, and the browser hangs DevTools on it instead. */
	| "copySelection";

export interface TerminalKeyEventShape {
	type: string;
	key: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	isMac: boolean;
	hasSelection: boolean;
}

export function terminalKeyAction(ev: TerminalKeyEventShape): TerminalKeyAction {
	// The keyup of an intercepted chord must pass through untouched: xterm's
	// own keyup handling (refocusing among other things) consults this too.
	if (ev.type !== "keydown") return "passthrough";
	const key = ev.key.toLowerCase();

	// The conventional terminal copy chord. No browser fires a copy event for
	// it, and Chrome and Firefox bind DevTools to it, so the selection is
	// written to the clipboard here and the chord is consumed either way.
	if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && key === "c") return "copySelection";

	// Copy wins over SIGINT while a selection exists (the rule VS Code's
	// terminal follows, uniformly across platforms): step aside so the
	// browser's copy event fires onto xterm's selection.
	if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && key === "c" && ev.hasSelection)
		return "letBrowserCopy";

	// Ctrl+V is ^V (readline quoted-insert) as far as xterm is concerned, and
	// its cancel() would swallow the paste event — step aside and let the
	// event through instead. Meta+V never needs this: xterm leaves it alone,
	// and the browser pastes on its own. Alt is excluded so Alt-combos that
	// mean ESC-prefixed keys keep reaching the shell.
	if (ev.ctrlKey && !ev.metaKey && !ev.altKey && key === "v") return "letBrowserPaste";

	return "passthrough";
}
