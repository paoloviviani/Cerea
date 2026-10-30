/**
 * The stand-alone rows at the top of a sidebar tree (Schedules): one address, the same shape in the
 * chat tree (`NavMenu`) and the agents tree (`CodeNavTree`), so the two can never drift. A button
 * uses the same classes; block layout comes from the caller (`w-full` for a full-width row).
 */
export const SIDEBAR_ITEM =
	"flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700";
export const SIDEBAR_ITEM_ACTIVE =
	"flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-white";
