import { describe, expect, it } from "vitest";
import { EXECUTION_SYSTEM_PROMPT, injectExecutionPrompt } from "./executionPrompt";

/**
 * Two honest channels over one engine, plus the file-deliverable convention:
 * when the user asks for a file, the file is the deliverable and the model
 * must not narrate a run-it-yourself ritual (base64 pastes, local installs) —
 * the app surfaces the download itself. When the user asks for code,
 * presentation is unchanged.
 */
describe("execution prompt", () => {
	it("tells file-deliverables apart from code-deliverables", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the file is the deliverable, not the code");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("do not paste base64");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the code is the deliverable");
	});

	it("keeps the standing code-block contract intact", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("executed automatically");
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"You do NOT see the code block's execution output yourself"
		);
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no network access");
	});

	it("describes the autonomous tool channel honestly", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("execute_code");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("You see the truncated stdout");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("Run, read the output, fix, run again");
		// The unavailable fallback: never claim results, fall back to a fence.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("execution environment is unavailable");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("fall back to a code block");
	});

	it("pins the tool to the function-calling mechanism and away from reply markup", () => {
		// Recorded live (glm-5.3-flash, 2026-09-15): with the tool advertised and
		// nothing here saying HOW to call it, the model invented an XML tag from
		// the tool's name and wrote the call into its reply as text — twice, even
		// after the runMcpFlow leak correction. Nothing tells a model the markup
		// did nothing (from its side the turn just ends), so the only fix before
		// the recovery path existed was this paragraph. The wording names the
		// mechanism and the consequence, and deliberately shows no example of the
		// broken syntax: models imitate examples, and the tag they would imitate
		// is the one invented from the tool name in the first place.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("function-calling mechanism, as a real tool call");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("NEVER write the call into your reply as text");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("nothing runs, no result ever comes back");
		// Showing code is the fence channel's job, and the paragraph must say so —
		// otherwise "illustrate the call" and "make the call" share one syntax.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("use a fenced code block");
	});

	it("states the stdlib-only reality instead of promising packages", () => {
		// The deployment's micropip index is empty by default, so naming
		// installable packages invites exactly the ModuleNotFoundError two
		// models walked into on the file-deliverable test.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no package installation");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("only the Python standard library");
		expect(EXECUTION_SYSTEM_PROMPT).not.toContain("numpy, pandas");
	});

	it("forbids claiming files the code never wrote", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"Only ever describe files your code block actually wrote"
		);
	});

	it("injects the convention with the prompt", () => {
		expect(injectExecutionPrompt("Be brief.")).toContain("the file is the deliverable");
		expect(injectExecutionPrompt(undefined)).toContain("the file is the deliverable");
	});
});
