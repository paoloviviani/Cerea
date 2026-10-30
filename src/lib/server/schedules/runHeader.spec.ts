import { describe, expect, it } from "vitest";
import { headerName, relativeAgo, scheduledRunHeader } from "./runHeader";

const now = new Date("2026-10-08T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3_600_000;

describe("relativeAgo", () => {
	it("reads minutes, hours and days, and none", () => {
		expect(relativeAgo(null, now)).toBe("none");
		expect(relativeAgo(ago(20_000), now)).toBe("just now");
		expect(relativeAgo(ago(15 * 60_000), now)).toBe("15 min ago");
		expect(relativeAgo(ago(3 * H + 60_000), now)).toBe("3 h ago");
		expect(relativeAgo(ago(47 * H), now)).toBe("47 h ago");
		expect(relativeAgo(ago(50 * H), now)).toBe("2 days ago");
	});
});

describe("headerName", () => {
	it("flattens whitespace, drops brackets and quotes, and caps the length", () => {
		expect(headerName('a ]\n[b\t"c"')).toBe("a b c");
		expect(headerName("x".repeat(200))).toHaveLength(80);
	});
});

describe("scheduledRunHeader", () => {
	it("is one bracketed line", () => {
		const line = scheduledRunHeader({
			name: "Nightly",
			recurrence: { type: "daily", at: "02:00" },
			timezone: "Europe/Rome",
			previousRunAt: ago(3 * H),
			now,
			coordination: "session_list, session_read",
		});
		expect(line).toBe(
			'[Scheduled run of "Nightly", every day at 02:00 (Europe/Rome); previous run 3 h ago; coordination: session_list, session_read]'
		);
	});
});

describe("scheduledChatHeader", () => {
	it("says what an unattended chat run cannot do", async () => {
		const { scheduledChatHeader } = await import("./runHeader");
		const header = scheduledChatHeader({
			name: 'Weekly "news"',
			recurrence: { type: "weekly", day: 1, at: "08:00" },
			timezone: "Europe/Rome",
			previousRunAt: null,
			now: new Date("2026-10-26T08:00:00Z"),
		});
		expect(header).toBe(
			'[Scheduled run of "Weekly news", every Monday at 08:00 (Europe/Rome); previous run none; ' +
				"unattended: nobody is watching, so there is no Python sandbox and no question can be asked, " +
				"and any tool that needs approval is refused]"
		);
	});

	it("stamps a run in the schedule's own zone", async () => {
		const { runStamp } = await import("./runHeader");
		expect(runStamp(new Date("2026-10-08T07:00:00Z"), "Europe/Rome")).toBe("2026-10-08 09:00");
	});
});
