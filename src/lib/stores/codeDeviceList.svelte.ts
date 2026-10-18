import { CodeApiError, listDevices, loadCodeStatus, type CodeDeviceView } from "$lib/codeApi";
import { onAppResume } from "$lib/utils/appResume";
import { codeReauth, onCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * The one shared poll of paired machines. `CodeNavTree` (the tree, every
 * mutation) and `CodePanel` (the empty-state / pending-approval branches)
 * are siblings that both need this list; before this store existed each
 * polled it separately every 8s (X4) — one interval, ref-counted across
 * however many consumers are mounted, replaces both.
 */
export const codeDeviceList = $state<{ devices: CodeDeviceView[]; loading: boolean }>({
	devices: [],
	loading: true,
});

const POLL_MS = 8000;

let pollHandle: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
let stopResume: (() => void) | null = null;

// A stale sign-in drops what the machines told us: the list, and with it every
// name and count the tree and the inbox would draw. The poll also stops asking.
onCodeReauth(() => {
	codeDeviceList.devices = [];
	codeDeviceList.loading = false;
});

// Bumped by every local mutation (and every new read): a list read that
// started before it is stale and must not overwrite what the mutation
// already showed, or a revoked machine's card would reappear until the next
// poll tick.
let listEpoch = 0;

/** A machine was revoked/removed: drop it from the shared list now, without
 * waiting on a round trip, and discard any list read still in flight. */
export function dropCodeDevice(id: string): void {
	listEpoch += 1;
	codeDeviceList.devices = codeDeviceList.devices.filter((d) => d.id !== id);
}

export async function refreshCodeDevices(): Promise<void> {
	if (codeReauth.required) return;
	const epoch = ++listEpoch;
	try {
		const { devices } = await listDevices();
		if (epoch === listEpoch) codeDeviceList.devices = devices;
	} catch (err) {
		// A 401 that is not the stale-sign-in answer means there is no session
		// at all (it lapsed while the tab was open): the list cannot come back
		// by polling. Ask `/status`, which flags it and sends the person to
		// sign in again, rather than keeping a list of machines frozen as it
		// was. Any other failure is transient: keep the last good list rather
		// than blanking the tree; the next poll tick tries again.
		if (err instanceof CodeApiError && err.status === 401) void loadCodeStatus(true);
	} finally {
		codeDeviceList.loading = false;
	}
}

/** Call from `onMount`; call the returned function from its cleanup. The
 * interval runs while at least one consumer is mounted, and stops with the
 * last one — never zero, never more than one. */
export function useCodeDevicePoll(): () => void {
	refCount += 1;
	if (refCount === 1) {
		void refreshCodeDevices();
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
