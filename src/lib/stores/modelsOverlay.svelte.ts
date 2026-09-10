/**
 * Opening the models dialog from anywhere.
 *
 * Per-model settings used to be a page, so every affordance that led to them
 * was a link: the composer's model name, the introduction's gear, the model
 * list, the settings nav. The page is gone and the dialog replaced it — and a
 * dialog has no address, so those links need something to call instead.
 *
 * One module-level rune rather than context, because the callers are scattered
 * across the tree (`ChatWindow`, `ChatIntroduction`, `ChatMessage`, the models
 * page, `NavMenu`) and nothing useful encloses all of them. The dialog itself
 * is mounted once in the root layout, which is the only place guaranteed to be
 * present whichever route is showing.
 */

const state = $state<{ open: boolean; modelId: string | undefined }>({
	open: false,
	modelId: undefined,
});

export const modelsOverlay = {
	get open() {
		return state.open;
	},
	get modelId() {
		return state.modelId;
	},
	/** With an id, opens on that model's settings; without, on the list. */
	show(modelId?: string) {
		state.modelId = modelId;
		state.open = true;
	},
	hide() {
		state.open = false;
		// Cleared, so the next open with no id shows the list rather than
		// whichever model was looked at last.
		state.modelId = undefined;
	},
};
