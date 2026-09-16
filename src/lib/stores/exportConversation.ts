import { writable } from "svelte/store";

/**
 * Mirrors shareModal.ts's shape, but the export button lives in two places
 * (the desktop toolbar in ChatWindow, the mobile top bar in MobileNav) that
 * don't share a component tree — MobileNav renders in the root layout, so it
 * can't read ChatWindow's local state directly. ChatWindow keeps this store
 * in sync with its own `canExport`/`loading` derivations and resets it on
 * destroy, so a stale enabled button never survives a navigation away from
 * the conversation that produced it.
 */
export interface ExportConversationState {
	canExport: boolean;
	loading: boolean;
	run: () => void;
}

const DEFAULT_STATE: ExportConversationState = {
	canExport: false,
	loading: false,
	run: () => {},
};

function createExportConversationStore() {
	const { subscribe, set } = writable<ExportConversationState>(DEFAULT_STATE);

	return {
		subscribe,
		set,
		reset: () => set(DEFAULT_STATE),
	};
}

export const exportConversation = createExportConversationStore();
