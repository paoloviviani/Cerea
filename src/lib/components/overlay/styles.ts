/**
 * The chat's own dialog language, in one place.
 *
 * These strings are lifted **verbatim** from `mcp/MCPServerManager.svelte` and
 * `mcp/ServerCard.svelte`, which is the design this app already had: an
 * overlay rather than a page, blue-600 as the single accent, gradient cards
 * that tint blue when active, rounded-full status pills, dashed empty states.
 * Knowledge, projects and models were built as prose pages with black
 * buttons and no accent, which is why they looked like a different product.
 *
 * Kept as constants rather than copied into each screen for the obvious
 * reason: four screens repeating a class list is four screens that drift. The
 * MCP dialog still inlines its own and is deliberately left alone — it is the
 * reference, and rewriting it to import from here would put the definition one
 * step away from the thing that defines it. If it is ever touched, it should
 * adopt these.
 *
 * Two conventions worth knowing before adding to this file. `btn` is a project
 * class, not a Tailwind one. And the gradient cards use `bg-linear-to-br`,
 * which is Tailwind 4's spelling of `bg-gradient-to-br` — the older name
 * silently does nothing here.
 */

/** Overlay widths: a list is wide, a form is not. */
export const OVERLAY_WIDE = "w-[800px]";
export const OVERLAY_NARROW = "w-[600px]";

export const PANEL = "p-6";

/** Title and subtitle block at the top of every overlay. */
export const HEADER = "mb-6";
export const TITLE = "mb-1 text-xl font-semibold text-gray-900 dark:text-gray-200";
export const SUBTITLE = "text-sm text-gray-600 dark:text-gray-400";

/** The tinted strip under the header: a count, a state, and the actions. */
export const STRIP =
	"mb-6 flex justify-between rounded-lg p-4 max-sm:flex-col max-sm:gap-4 sm:items-center";
export const STRIP_ACTIVE = "bg-blue-50 dark:bg-blue-900/10";
export const STRIP_IDLE = "bg-gray-100 dark:bg-white/5";
export const STRIP_TILE = "flex size-10 items-center justify-center rounded-xl bg-blue-500/10";
export const STRIP_HEADLINE = "text-sm font-semibold text-gray-900 dark:text-gray-100";
export const STRIP_DETAIL = "text-xs text-gray-600 dark:text-gray-400";

/** Buttons. `PRIMARY` is the only place blue is a fill rather than a tint. */
export const PRIMARY =
	"btn flex items-center gap-1.5 rounded-lg bg-blue-600 py-1.5 pr-3 pl-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50";
export const SECONDARY =
	"btn gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700";
/** The smaller pair, for actions inside a card. */
export const CARD_ACTION =
	"flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600";
export const CARD_DESTRUCTIVE =
	"flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-[.29rem] text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50";

/** A section of cards, with its count in the heading. */
export const SECTION_TITLE = "mb-3 text-sm font-medium text-gray-700 dark:text-gray-300";
export const GRID = "grid grid-cols-1 gap-3 md:grid-cols-2";
export const STACK = "space-y-5";

/**
 * A card. `active` is the blue-tinted state — the selected server, the model
 * this chat runs on, a knowledge base attached to what is being edited.
 */
export function card(active: boolean): string {
	return active
		? "rounded-lg border bg-linear-to-br transition-colors border-blue-600/20 bg-blue-50 from-blue-500/5 to-transparent dark:border-blue-700/60 dark:bg-blue-900/10 dark:from-blue-900/20"
		: "rounded-lg border bg-linear-to-br transition-colors border-gray-200 bg-white from-black/5 dark:border-gray-700 dark:bg-gray-800 dark:from-white/5";
}
export const CARD_BODY = "px-4 py-3.5";
export const CARD_TITLE = "truncate font-semibold text-gray-900 dark:text-gray-100";
export const CARD_SUBTITLE = "truncate text-sm text-gray-600 dark:text-gray-400";

/** Status pills. The tone names are the states this app actually shows. */
export const PILL =
	"inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-xs font-medium";
export const PILL_TONES = {
	good: "bg-green-100 text-green-600 dark:bg-green-900/20 dark:text-green-400",
	busy: "bg-blue-100 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400",
	bad: "bg-red-100 text-red-600 dark:bg-red-900/20 dark:text-red-400",
	neutral: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400",
} as const;
export type PillTone = keyof typeof PILL_TONES;

export const EMPTY =
	"flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-8 dark:border-gray-700";
export const EMPTY_ICON = "mb-3 size-12 text-gray-400";
export const EMPTY_TITLE = "mb-1 text-sm font-medium text-gray-900 dark:text-gray-100";
export const EMPTY_DETAIL = "mb-4 text-xs text-gray-600 dark:text-gray-400";

/** The closing note every MCP view ends on. */
export const TIPS = "rounded-lg bg-gray-50 p-4 dark:bg-gray-700";
export const TIPS_TITLE = "mb-2 text-sm font-medium text-gray-900 dark:text-gray-100";
export const TIPS_LIST = "space-y-1 text-xs text-gray-600 dark:text-gray-400";

/** Form controls, in the same idiom as the add-server form. */
export const LABEL = "mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300";
export const INPUT =
	"w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
export const HINT = "mt-1 text-xs text-gray-500 dark:text-gray-400";
export const SEARCH =
	"w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900";
export const ERROR =
	"rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300";
export const NOTICE =
	"rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-900/10 dark:text-blue-300";
