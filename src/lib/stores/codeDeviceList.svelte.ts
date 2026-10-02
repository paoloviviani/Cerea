import { listDevices, type CodeDeviceView } from "$lib/codeApi";
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

// A stale sign-in drops what the machines told us: the list, and with it every
// name and count the tree and the inbox would draw. The poll also stops asking.
onCodeReauth(() => {
	codeDeviceList.devices = [];
	codeDeviceList.loading = false;
});

export async function refreshCodeDevices(): Promise<void> {
	if (codeReauth.required) return;
	try {
		codeDeviceList.devices = (await listDevices()).devices;
	} catch {
		// A transient failure keeps the last good list rather than blanking
		// the tree; the next poll tick tries again.
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
	}
	return () => {
		refCount = Math.max(0, refCount - 1);
		if (refCount === 0 && pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
	};
}

export type { CodeDeviceView };
