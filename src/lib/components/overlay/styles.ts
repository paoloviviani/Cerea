/**
 * The chat's own dialog language, in one place.
 *
 * These strings were lifted **verbatim** from `mcp/MCPServerManager.svelte`
 * and `mcp/ServerCard.svelte`, which is the design this app already had: an
 * overlay rather than a page, blue-600 as the single accent, gradient cards
 * that tint blue when active, rounded-full status pills, dashed empty states.
 * Knowledge, projects and models were built as prose pages with black
 * buttons and no accent, which is why they looked like a different product.
 *
 * Since ADR 0077 they are expressed through the vendored design tokens
 * (`src/styles/tokens.css`, a byte copy of the console's file) instead of
 * literal Tailwind colours: `bg-accent` reads `var(--colour-accent)` at
 * runtime, so the `.dark` block in that file re-themes every constant here
 * with no `dark:` variant. A palette change lands as a change to that one
 * file — the property that let the console be restyled three times at that
 * price, now shared rather than reimplemented.
 *
 * Kept as constants rather than copied into each screen for the obvious
 * reason: four screens repeating a class list is four screens that drift. The
 * MCP dialog still inlines its own and is deliberately left alone — it is the
 * reference, and rewriting it to import from here would put the definition one
 * step away from the thing that defines it. If it is ever touched, it should
 * adopt these.
 *
 * Three conventions worth knowing before adding to this file. `btn` is a
 * project class, not a Tailwind one. The gradient cards use `bg-linear-to-br`,
 * which is Tailwind 4's spelling of `bg-gradient-to-br` — the older name
 * silently does nothing here. And fills that carry white text use
 * `bg-accent-solid`, the pinned blue-600 step, never `bg-accent`: the text
 * step lifts toward blue-400 in the dark theme for legibility on dark
 * grounds, and a fill that followed it would drop white text under 3:1.
 */

/** Overlay widths: a list is wide, a form is not, a picker is narrower still. */
export const OVERLAY_WIDE = "w-[800px]";
export const OVERLAY_NARROW = "w-[600px]";
/**
 * A picker lists rows, not forms: a name, one truncated meta line and a check
 * never need more than ~340px of text, so 420px is truncation margin for the
 * longest ids rather than the empty width a form overlay carries.
 */
export const OVERLAY_PICKER = "w-[420px]";

export const PANEL = "p-6";

/**
 * The manager as a workspace tab. Models, MCP servers and knowledge moved from
 * overlays to tabs of `/workspace`; the overlay shell (a `Modal`, a backdrop, a
 * close button) is gone, and what used to sit inside it is carried by this
 * card instead — the page draws the scroll, the card draws the surface.
 */
export const EMBEDDED = "rounded-2xl border border-line bg-surface";

/** Title and subtitle block at the top of every overlay. */
export const HEADER = "mb-6";
export const TITLE = "mb-1 text-xl font-semibold text-ink";
export const SUBTITLE = "text-sm text-ink-muted";

/** The tinted strip under the header: a count, a state, and the actions. */
export const STRIP =
	"mb-6 flex justify-between rounded-lg p-4 max-sm:flex-col max-sm:gap-4 sm:items-center";
export const STRIP_ACTIVE = "bg-accent-subtle";
export const STRIP_IDLE = "bg-sunken";
/**
 * The icon tile keeps a translucent accent wash rather than the subtle fill,
 * so it still reads as a tile when the strip behind it is the same subtle
 * fill. Callers add `grayscale` when the strip is idle.
 */
export const STRIP_TILE = "flex size-10 items-center justify-center rounded-xl bg-accent/15";
export const STRIP_HEADLINE = "text-sm font-semibold text-ink";
export const STRIP_DETAIL = "text-xs text-ink-muted";

/**
 * Buttons. `PRIMARY` is the only place blue is a fill rather than a tint, and
 * the fill is the pinned solid step — the chat's blue-600 button is the same
 * blue in both themes.
 */
export const PRIMARY =
	"btn flex items-center gap-1.5 rounded-lg bg-accent-solid py-1.5 pr-3 pl-2 text-sm font-medium text-white hover:bg-accent-solid-hover disabled:opacity-50";
export const SECONDARY =
	"btn gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-sunken disabled:opacity-50";
/** The smaller pair, for actions inside a card. */
export const CARD_ACTION =
	"flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-[.29rem] text-xs font-medium text-ink hover:bg-sunken disabled:opacity-50";
/**
 * Destructive actions borrow the danger text tone rather than a red fill, so
 * the hover can deepen the border — a second background step would need a
 * token the palette does not have.
 */
export const CARD_DESTRUCTIVE =
	"flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger-subtle px-2.5 py-[.29rem] text-xs font-medium text-danger hover:border-danger/50 disabled:opacity-50";

/** A section of cards, with its count in the heading. */
export const SECTION_TITLE = "mb-3 text-sm font-medium text-ink-muted";
export const GRID = "grid grid-cols-1 gap-3 md:grid-cols-2";
export const STACK = "space-y-5";

/**
 * A card. `active` is the blue-tinted state — the selected server, the model
 * this chat runs on, a knowledge base attached to what is being edited. The
 * gradient washes use opacity modifiers on the tokens, so they follow the
 * theme the same way the grounds do.
 */
export function card(active: boolean): string {
	return active
		? "rounded-lg border bg-linear-to-br transition-colors border-accent/20 bg-accent-subtle from-accent/5 to-transparent"
		: "rounded-lg border bg-linear-to-br transition-colors border-line bg-surface from-ink/5 to-transparent";
}
export const CARD_BODY = "px-4 py-3.5";
export const CARD_TITLE = "truncate font-semibold text-ink";
export const CARD_SUBTITLE = "truncate text-sm text-ink-muted";

/**
 * Status pills. The tone names are the states this app actually shows. Text
 * tones sit at the 700 step, not the chat's old 600: blue-600 on blue-100 is
 * 4.2:1 and green-600 on green-100 is 3.0:1, both under the 4.5:1 floor the
 * shared palette holds; the 700 steps clear it on the same fills.
 */
export const PILL =
	"inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-xs font-medium";
export const PILL_TONES = {
	good: "bg-ok-subtle text-ok",
	busy: "bg-accent-subtle text-accent",
	bad: "bg-danger-subtle text-danger",
	neutral: "bg-sunken text-ink-muted",
} as const;
export type PillTone = keyof typeof PILL_TONES;

export const EMPTY =
	"flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-line-strong p-8";
export const EMPTY_ICON = "mb-3 size-12 text-ink-faint";
export const EMPTY_TITLE = "mb-1 text-sm font-medium text-ink";
export const EMPTY_DETAIL = "mb-4 text-xs text-ink-muted";

/** The closing note every MCP view ends on. */
export const TIPS = "rounded-lg bg-sunken p-4";
export const TIPS_TITLE = "mb-2 text-sm font-medium text-ink";
export const TIPS_LIST = "space-y-1 text-xs text-ink-muted";

/** Form controls, in the same idiom as the add-server form. */
export const LABEL = "mb-1.5 block text-sm font-medium text-ink";
export const INPUT =
	"w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:ring-1 focus:ring-accent focus:outline-hidden disabled:opacity-60";
export const HINT = "mt-1 text-xs text-ink-faint";
export const SEARCH =
	"w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent focus:ring-1 focus:ring-accent focus:outline-hidden";
export const ERROR =
	"rounded-lg border border-danger/25 bg-danger-subtle px-3 py-2 text-sm text-danger";
export const NOTICE = "rounded-lg bg-accent-subtle px-3 py-2 text-xs text-accent";
