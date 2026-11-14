import { describe, expect, it } from "vitest";
import { notesSessionId } from "./agentNotesSession";

describe("notesSessionId", () => {
	it("is the session itself for a top-level session, or before it has loaded", () => {
		expect(notesSessionId({ rootId: "ses_a" }, "ses_a")).toBe("ses_a");
		expect(notesSessionId({}, "ses_a")).toBe("ses_a");
		expect(notesSessionId(null, "ses_a")).toBe("ses_a");
		expect(notesSessionId(undefined, "ses_a")).toBe("ses_a");
	});

	it("is the root for a child session", () => {
		expect(notesSessionId({ rootId: "ses_root" }, "ses_child")).toBe("ses_root");
	});
});
