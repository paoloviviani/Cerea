/**
 * Collapsed state for the `/code` sidebar tree (1b): which devices and
 * which device+workspace groups are collapsed, remembered per browser
 * across reloads. Only the collapsed ones are stored — a device nobody has
 * ever touched is expanded by default, so an empty or missing record reads
 * the same as "nothing collapsed."
 *
 * A collapsed device's compact badge (its workspace count) has to survive
 * a reload too, even though lazy loading (1b) means a collapsed device's
 * subtree is not re-fetched on that reload. `deviceCounts` is the last
 * count seen while the device's subtree *was* loaded, carried in the same
 * record so the badge reads "as of last time this was loaded" rather than
 * disappearing. A workspace's own session-count badge needs no such cache:
 * a workspace row only ever renders once its device's subtree is loaded,
 * so that count is always live.
 */

export const CODE_TREE_COLLAPSE_KEY = "code.tree.collapsed";

export interface TreeCollapseState {
	/** Collapsed device ids. */
	devices: string[];
	/** Collapsed `deviceId:workspaceId` pairs (`workspaceKey` below). */
	workspaces: string[];
	/** deviceId -> its last-known workspace count. */
	deviceCounts: Record<string, number>;
}

const EMPTY: TreeCollapseState = { devices: [], workspaces: [], deviceCounts: {} };

/** A workspace's collapsed-state key is namespaced by device: workspace
 * ids are only unique within their own device's registry. */
export function workspaceKey(deviceId: string, workspaceId: string): string {
	return `${deviceId}:${workspaceId}`;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === "number")
	);
}

/** Guards the parse: corrupt or foreign JSON in this key reads as nothing
 * collapsed rather than throwing into the sidebar's render. */
export function readTreeCollapse(storage: Pick<Storage, "getItem"> | undefined): TreeCollapseState {
	const raw = storage?.getItem(CODE_TREE_COLLAPSE_KEY);
	if (!raw) return EMPTY;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return EMPTY;
		const { devices, workspaces, deviceCounts } = parsed as Record<string, unknown>;
		return {
			devices: isStringArray(devices) ? devices : [],
			workspaces: isStringArray(workspaces) ? workspaces : [],
			deviceCounts: isNumberRecord(deviceCounts) ? deviceCounts : {},
		};
	} catch {
		return EMPTY;
	}
}

export function writeTreeCollapse(
	storage: Pick<Storage, "setItem"> | undefined,
	state: TreeCollapseState
): void {
	storage?.setItem(CODE_TREE_COLLAPSE_KEY, JSON.stringify(state));
}

/** Drops entries for devices that no longer exist (a device revoked in
 * another tab, or from before an account's devices were reset) — carried
 * forever otherwise, since nothing else ever cleans this key. */
export function pruneTreeCollapse(
	state: TreeCollapseState,
	knownDeviceIds: ReadonlySet<string>
): TreeCollapseState {
	const devices = state.devices.filter((id) => knownDeviceIds.has(id));
	const workspaces = state.workspaces.filter((key) => knownDeviceIds.has(key.split(":")[0] ?? ""));
	const deviceCounts = Object.fromEntries(
		Object.entries(state.deviceCounts).filter(([id]) => knownDeviceIds.has(id))
	);
	if (
		devices.length === state.devices.length &&
		workspaces.length === state.workspaces.length &&
		Object.keys(deviceCounts).length === Object.keys(state.deviceCounts).length
	) {
		return state;
	}
	return { devices, workspaces, deviceCounts };
}
