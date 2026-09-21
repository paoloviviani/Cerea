/**
 * The code-box button chrome, shared by CodeBlock and FileCard so the two
 * cannot drift: a fence and a generated file are different things with the
 * same actions, and the operator asked that they read as one family.
 *
 * Both live on bordered white (gray-900 dark) surfaces, so the buttons float
 * over code with a backdrop blur and a hairline border rather than sitting
 * in a tinted strip. Text-link buttons (blue, borderless) must not come
 * back: inside a white card they read as body text, not controls.
 */

/** Preview/Run pill: play icon + label, e.g. CodeBlock's Preview. */
export const CODE_PILL_BUTTON =
	"btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-xs backdrop-blur-sm transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500";

/** Square icon button: copy in CodeBlock, download in FileCard. */
export const CODE_ICON_BUTTON =
	"btn transition-none rounded-lg border size-7 text-sm shadow-xs dark:bg-gray-600/50 backdrop-blur-sm dark:hover:border-gray-500 active:shadow-inner dark:border-gray-600 hover:border-gray-500";

/** Icon size inside the square button. */
export const CODE_ICON_SIZE = "size-3";

/**
 * The card surface both components sit on. Mirrors the `.prose pre` tokens
 * (white, hairline border, gray-900 dark) so a file box and a code box are
 * the same white — stated here rather than inherited from prose because
 * deliverable cards also render outside prose (run output, side panel).
 */
export const CODE_CARD_SURFACE =
	"rounded-lg border-[0.5px] border-gray-200/70 bg-white dark:border-gray-700 dark:bg-gray-900";
