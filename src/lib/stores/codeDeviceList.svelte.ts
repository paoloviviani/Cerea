import { CodeApiError, listDevices, loadCodeStatus, type CodeDeviceView } from "$lib/codeApi";
import { reconcileById } from "$lib/utils/reconcileById";
import { onAppResume } from "$lib/utils/appResume";
import { codeReauth, onCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * The one shared poll of paired machines. `CodeNavTree` (the tree, every
 * mutation) and `CodePanel` (the empty-state / pending-approval branches)
 * are siblings that both need this list; before this store existed each
 * polled it separately every 8s (X4) — one interval, ref-counted across
 * however many consumers are mounted, replaces both.
 */
export const codeDeviceList = $state<{
	devices: CodeDeviceView[];
	loading: boolean;
	/** When the list was last read successfully; 0 before the first read. */
	fetchedAt: number;
}>({
	devices: [],
	loading: true,
	fetchedAt: 0,
});

const POLL_MS = 8000;
/** The list is kept across visits (stale-while-revalidate); entering the
 * panel re-reads it only once it is older than this. */
export const CODE_LIST_STALE_MS = 30_000;

let pollHandle: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
let stopResume: (() => void) | null = null;

// A stale sign-in drops what the machines told us: the list, and with it every
// name and count the tree and the inbox would draw. The poll also stops asking.
onCodeReauth(() => {
	codeDeviceList.devices = [];
	codeDeviceList.loading = false;
	codeDeviceList.fetchedAt = 0;
});

/** Sign-out or another account: forget the list, and show the loading state
 * again until the next account's own read lands. */
export function clearCodeDeviceList(): void {
	listEpoch += 1;
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	codeDeviceList.fetchedAt = 0;
}

// Bumped by every local mutation (and every new read): a list read that
// started before it is stale and must not overwrite what the mutation
// already showed, or a revoked machine's card would reappear until the next
// poll tick.
let listEpoch = 0;

/**
 * Whether a device belongs in the Agents panel. A connectors machine (`machine.mode`, ADR 0102)
 * runs no coding agent: it is managed under the workspace's Local connectors tab, and the nav
 * tree, the empty state, the handoff and schedule target pickers must never offer it. The server
 * leaves such machines out of this list already; this is the same rule at the one place every
 * consumer reads, so a machine that slips through (an older server) still never shows.
 */
export function isAgentDevice(device: CodeDeviceView): boolean {
	return device.machine?.mode !== "connectors";
}

/** A machine was revoked/removed: drop it from the shared list now, without
 * waiting on a round trip, and discard any list read still in flight. */
export function dropCodeDevice(id: string): void {
	listEpoch += 1;
	codeDeviceList.loading = false;
	codeDeviceList.devices = codeDeviceList.devices.filter((d) => d.id !== id);
}

/** Re-read the list and fold it in place (unchanged machines keep their
 * rows). `ifStale` skips the read while the cached list is still young: the
 * visit's first read, which must not flash or refetch on every return. A
 * failed read keeps the cached list. */
export async function refreshCodeDevices(opts: { ifStale?: boolean } = {}): Promise<void> {
	if (codeReauth.required) return;
	if (opts.ifStale && Date.now() - codeDeviceList.fetchedAt < CODE_LIST_STALE_MS) return;
	const epoch = ++listEpoch;
	try {
		const { devices } = await listDevices();
		if (epoch === listEpoch) {
			const next = reconcileById(codeDeviceList.devices, devices.filter(isAgentDevice));
			if (next !== codeDeviceList.devices) codeDeviceList.devices = next;
			codeDeviceList.fetchedAt = Date.now();
		}
	} catch (err) {
		// A 401 that is not the stale-sign-in answer means there is no session
		// at all (it lapsed while the tab was open): the list cannot come back
		// by polling. Ask `/status`, which flags it and sends the person to
		// sign in again, rather than keeping a list of machines frozen as it
		// was. Any other failure is transient: keep the last good list rather
		// than blanking the tree; the next poll tick tries again.
		if (err instanceof CodeApiError && err.status === 401) void loadCodeStatus(true);
	} finally {
		if (epoch === listEpoch) codeDeviceList.loading = false;
	}
}

/** Call from `onMount`; call the returned function from its cleanup. The
 * interval runs while at least one consumer is mounted, and stops with the
 * last one — never zero, never more than one. */
export function useCodeDevicePoll(): () => void {
	refCount += 1;
	if (refCount === 1) {
		void refreshCodeDevices({ ifStale: true });
		pollHandle = setInterval(() => void refreshCodeDevices(), POLL_MS);
		// A sleeping tab's interval is throttled or frozen: re-read the moment
		// the app is back, and let a returning sign-in clear the stale flag.
		stopResume = onAppResume(() => {
			if (codeReauth.required) void loadCodeStatus(true);
			void refreshCodeDevices();
		});
	}
	return () => {
		refCount = Math.max(0, refCount - 1);
		if (refCount === 0 && pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
			stopResume?.();
			stopResume = null;
		}
	};
}

export type { CodeDeviceView };
