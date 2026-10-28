import { browser } from "$app/environment";
import { base } from "$app/paths";
import type { Accent, Neutral } from "$lib/utils/palettes";
import type { ReasoningEffort, StreamingMode } from "$lib/types/Settings";
import type { LocationMode } from "$lib/utils/location";
import { getContext, setContext } from "svelte";
import { type Writable, writable, get } from "svelte/store";

type SettingsStore = {
	webSearchEnabled?: boolean;
	toolApprovalPolicy?: "always-allow" | "manual";
	pyodidePyPiInstallEnabled?: boolean;
	memoryEnabled?: boolean;
	locationMode?: LocationMode;
	locationPlace?: string;
	activeModel: string;
	globalSystemPrompt?: string;
	/** The administrator's instructions; only present when they chose to show them. Read-only. */
	adminInstructions?: string;
	multimodalOverrides: Record<string, boolean>;
	toolsOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	hidePromptExamples: Record<string, boolean>;
	reasoningEffortOverrides: Record<string, ReasoningEffort>;
	reasoningOverrides: Record<string, boolean>;
	recentlySaved: boolean;
	streamingMode: StreamingMode;
	directPaste: boolean;
	hapticsEnabled: boolean;
	billingOrganization?: string;
	accent?: Accent;
	neutral?: Neutral;
	locale?: string;
};

type SettingsStoreWritable = Writable<SettingsStore> & {
	instantSet: (settings: Partial<SettingsStore>) => Promise<void>;
	initValue: <K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) => Promise<void>;
};

export function useSettingsStore() {
	return getContext<SettingsStoreWritable>("settings");
}

export function createSettingsStore(initialValue: Omit<SettingsStore, "recentlySaved">) {
	const baseStore = writable({ ...initialValue, recentlySaved: false });

	let timeoutId: NodeJS.Timeout;
	let showSavedOnNextSync = false;

	async function setSettings(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			showSavedOnNextSync = true; // User edit, should show "Saved"
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				await fetch(`${base}/settings`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(get(baseStore)),
				});

				if (showSavedOnNextSync) {
					// set savedRecently to true for 3s
					baseStore.update((s) => ({
						...s,
						recentlySaved: true,
					}));
					setTimeout(() => {
						baseStore.update((s) => ({
							...s,
							recentlySaved: false,
						}));
					}, 3000);
				}

				showSavedOnNextSync = false;
			}, 300);
			// debounce server calls by 300ms
		}
	}

	async function initValue<K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) {
		const currentStore = get(baseStore);
		const currentNestedObject = currentStore[key] as Record<string, string | boolean>;

		// Only initialize if undefined
		if (currentNestedObject?.[nestedKey] !== undefined) {
			return;
		}

		// Update the store
		const newNestedObject = {
			...(currentNestedObject || {}),
			[nestedKey]: value,
		};

		baseStore.update((s) => ({
			...s,
			[key]: newNestedObject,
		}));

		// Save to server (debounced) - note: we don't set showSavedOnNextSync
		if (browser) {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				await fetch(`${base}/settings`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(get(baseStore)),
				});

				if (showSavedOnNextSync) {
					baseStore.update((s) => ({
						...s,
						recentlySaved: true,
					}));
					setTimeout(() => {
						baseStore.update((s) => ({
							...s,
							recentlySaved: false,
						}));
					}, 3000);
				}

				showSavedOnNextSync = false;
			}, 300);
		}
	}
	async function instantSet(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			await fetch(`${base}/settings`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					...get(baseStore),
					...settings,
				}),
			});
		}
	}

	const newStore = {
		subscribe: baseStore.subscribe,
		set: setSettings,
		instantSet,
		initValue,
		update: (fn: (s: SettingsStore) => SettingsStore) => {
			setSettings(fn(get(baseStore)));
		},
	} satisfies SettingsStoreWritable;

	setContext("settings", newStore);

	return newStore;
}
