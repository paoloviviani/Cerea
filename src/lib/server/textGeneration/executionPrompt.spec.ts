import { describe, expect, it } from "vitest";
import { EXECUTION_SYSTEM_PROMPT, injectExecutionPrompt } from "./executionPrompt";

/**
 * The file-deliverable convention: when the user asks for a file, the file
 * is the deliverable and the model must not narrate a run-it-yourself ritual
 * (base64 pastes, local installs) — the app surfaces the download itself.
 * When the user asks for code, presentation is unchanged.
 */
describe("execution prompt", () => {
	it("tells file-deliverables apart from code-deliverables", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the file is the deliverable, not the code");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("do not paste base64");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the code is the deliverable");
	});

	it("keeps the standing execution contract intact", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("executed automatically");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("You do NOT see the execution output yourself");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no network access");
	});

	it("injects the convention with the prompt", () => {
		expect(injectExecutionPrompt("Be brief.")).toContain("the file is the deliverable");
		expect(injectExecutionPrompt(undefined)).toContain("the file is the deliverable");
	});
});
