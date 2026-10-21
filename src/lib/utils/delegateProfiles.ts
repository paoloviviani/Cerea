/**
 * Whether the machine's delegate profiles can be edited from the panel right
 * now, and the sentence that says why not. One place for the sidebar's menu
 * and the dialog, so the two cannot word it differently.
 *
 * The machine's `delegateProfiles` capability (PROTOCOL.md §6 "Delegate
 * profiles") is what its hello reported; a galopin that predates the ops
 * reports nothing and answers both `unsupported`.
 */
import type { Policy } from "$lib/types/machineProtocol";

export const PROFILES_OFFLINE_DETAIL =
	"This machine is offline. Connect it to edit its delegate profiles.";
export const PROFILES_TOO_OLD_DETAIL =
	"This machine's galopin is too old for delegate profiles: update galopin on this machine.";
export const PROFILES_TOOLS_OFF_DETAIL =
	"This machine was enrolled without agent tools, so delegate profiles do not apply to it.";

interface DeviceFacts {
	online?: boolean;
	machine?: { capabilities?: { delegateProfiles?: boolean | null } | null } | null;
	policy?: Pick<Policy, "agentTools"> | null;
}

export type ProfilesSupport =
	{ ok: true } | { ok: false; reason: "offline" | "too-old" | "tools-off"; detail: string };

export function delegateProfilesSupport(device: DeviceFacts | undefined): ProfilesSupport {
	if (device?.online === false) {
		return { ok: false, reason: "offline", detail: PROFILES_OFFLINE_DETAIL };
	}
	if (device?.machine?.capabilities?.delegateProfiles !== true) {
		// A machine enrolled without agent tools has no profiles to edit whatever its
		// version; say that rather than asking for an update that would not help.
		if (device?.policy?.agentTools === "denied") {
			return { ok: false, reason: "tools-off", detail: PROFILES_TOOLS_OFF_DETAIL };
		}
		return { ok: false, reason: "too-old", detail: PROFILES_TOO_OLD_DETAIL };
	}
	return { ok: true };
}
