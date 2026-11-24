/**
 * How a computer's galopin is kept running (`hello.agent.runMode`): a short label and tooltip
 * in the Agents panel, so a user can see whether it is the service, a terminal left open, the
 * Mac app or a container, and what stopping it means. A word this Cerea does not know (from a
 * newer galopin) and an absent one (an older galopin) show nothing.
 */
export const RUN_MODES = ["service", "system_service", "terminal", "mac_app", "docker"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export function knownRunMode(mode: string | null | undefined): RunMode | null {
	return (RUN_MODES as readonly string[]).includes(mode ?? "") ? (mode as RunMode) : null;
}
