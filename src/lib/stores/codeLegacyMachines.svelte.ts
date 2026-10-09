import { onCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * Machines the panel has found to predate ceilings (`isLegacyMachine`): policy
 * with no ceiling and an `opencode.json` with no ask block, so they allow
 * everything until re-enrolled. Learned where the evidence is — a session's
 * `permission.rules` (the Permissions dialog) — and shown where the machine is
 * listed (`CodeNavTree`'s row), so the flag does not vanish when the session
 * is closed. Module state, like `codeEnrollment`: the row and the session
 * screen are siblings under different parents.
 */
export const codeLegacyMachines = $state<Record<string, boolean>>({});

// Machine-derived, so a stale sign-in drops it with the rest.
onCodeReauth(() => {
	for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
});
