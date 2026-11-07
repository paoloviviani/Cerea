import { describe, expect, it } from "vitest";
import { keepChat, markAbandonedFirstChat, takeAbandonedFirstChat } from "./abandonedChat";

describe("abandoned first chat", () => {
	it("hands the failed chat over once", () => {
		markAbandonedFirstChat("c1");
		expect(takeAbandonedFirstChat()).toBe("c1");
		expect(takeAbandonedFirstChat()).toBeUndefined();
	});
	it("forgets a chat the user went back into", () => {
		markAbandonedFirstChat("c2");
		keepChat("c2");
		expect(takeAbandonedFirstChat()).toBeUndefined();
	});
	it("keeps the mark when another chat is retried", () => {
		markAbandonedFirstChat("c3");
		keepChat("other");
		expect(takeAbandonedFirstChat()).toBe("c3");
	});
});
