import { describe, expect, it } from "vitest";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { FIRST_TURN_HINT, FIRST_TURN_LABEL, isFirstTurn, userTurns } from "./firstTurnSubagent";

const user = (text: string): AgentStreamUpdate => ({ type: "user", text });
const stream = { type: "stream", token: "x" } as unknown as AgentStreamUpdate;

describe("a subagent's first turn", () => {
	it("is a transcript with only its starting prompt, however long that turn has run", () => {
		expect(userTurns([user("do it"), stream, stream])).toBe(1);
		expect(isFirstTurn([user("do it"), stream, stream])).toBe(true);
	});

	it("is over once a second user message arrived", () => {
		expect(isFirstTurn([user("do it"), stream, user("and then this"), stream])).toBe(false);
	});

	it("reads an empty transcript as a first turn (nothing has been said beyond the start)", () => {
		expect(isFirstTurn([])).toBe(true);
	});

	it("words it the way the brief says, and never as a promise about later turns", () => {
		expect(FIRST_TURN_LABEL).toBe("New subagent · first turn asks");
		expect(FIRST_TURN_HINT).not.toMatch(/turn two|second turn|from turn|later turns/i);
	});
});
