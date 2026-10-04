/**
 * The composer's pill idiom, in one place. Chat's own toggles
 * (`TogglePill`) and /code's agent pickers (the mode pill, the permission
 * selector in `AgentComposer`) both build their classes from here, so the
 * two composers cannot drift apart in height, padding, text size, border or
 * accent again: they did, once, when the agent kept its own copy.
 *
 * Accent means one thing: the active choice. A resting pill or picker is
 * neutral gray; `PILL_PRESSED` (blue) marks a toggle that is on, or the
 * selected segment of a radio group.
 *
 * Under `sm` a pill with `compact` becomes a borderless `size-8` icon circle
 * (matching the composer's `+` button), and a text picker becomes a borderless
 * `h-8` text button: the phone row stays quiet and uniform.
 */

/** Height, padding, text, border and shape: shared by every composer pill. */
export const PILL_BASE =
	"flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-60";

/** Resting tone: neutral, never blue. `PILL_REST` alone is for a container
 * that is not itself clickable (the permission selector's group). */
export const PILL_REST =
	"border-gray-200 bg-white text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400";
export const PILL_OFF = `${PILL_REST} hover:bg-gray-50 dark:hover:bg-gray-700`;

/** The active choice: a pressed toggle, a selected segment. */
export const PILL_PRESSED =
	"border-blue-600 bg-blue-100 text-blue-800 shadow-xs dark:border-blue-400 dark:bg-blue-900/60 dark:text-blue-100";

/** An icon-only circle under `sm` (label kept for a screen reader). */
export const PILL_COMPACT =
	"max-sm:size-8 max-sm:justify-center max-sm:gap-0 max-sm:rounded-full max-sm:border-0 max-sm:bg-transparent max-sm:px-0 max-sm:text-base";

/** A pill that carries text (a picker's value) keeps its label under `sm`;
 * it takes the compact pills' row height and drops chrome the same way. */
export const PILL_PICKER_PHONE =
	"max-sm:h-8 max-sm:border-0 max-sm:bg-transparent max-sm:px-2 max-sm:text-sm";

export function composerPillClass(opts: {
	pressed?: boolean;
	/** Icon-only circle under `sm`. */
	compact?: boolean;
	/** Text picker: keeps its label under `sm`. */
	picker?: boolean;
}): string {
	return [
		PILL_BASE,
		opts.compact ? PILL_COMPACT : "",
		opts.picker ? PILL_PICKER_PHONE : "",
		opts.pressed ? PILL_PRESSED : PILL_OFF,
	]
		.filter(Boolean)
		.join(" ");
}
