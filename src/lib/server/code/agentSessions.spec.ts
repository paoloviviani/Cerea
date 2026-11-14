import { describe, expect, it } from "vitest";
import { busyReason, sessionState } from "./agentSessions";
import type { Session } from "$lib/types/machineProtocol";

const idle = { status: "idle", pendingPermissions: 0 } as unknown as Session;

describe("a parent whose subagents run in the background", () => {
	it("is not free for a scheduled run while a child works or waits", () => {
		expect(busyReason(idle)).toBeNull();
		const running = { ...idle, childSummary: { children: 1, running: 1, waiting: 0 } } as Session;
		expect(busyReason(running)).toMatch(/subagents still working/);
		const waiting = { ...idle, childSummary: { children: 1, running: 0, waiting: 1 } } as Session;
		expect(busyReason(waiting)).toMatch(/waiting for an approval/);
		expect(sessionState(running)).toBe("working");
		expect(sessionState(waiting)).toBe("needs-you");
		expect(
			sessionState({ ...idle, childSummary: { children: 1, running: 0, waiting: 0 } } as Session)
		).toBe("idle");
	});
});
