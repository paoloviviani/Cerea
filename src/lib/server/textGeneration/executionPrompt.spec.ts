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
	it("keeps execute_code from standing in for a missing tool or connector", () => {
		// Without this, a request for a service with no tool on offer was answered
		// by Python faking the service — the sandbox has no network to reach it.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("It is not a substitute for a tool you do not have");
		expect(EXECUTION_SYSTEM_PROMPT).toMatch(/must not simulate one/);
		expect(EXECUTION_SYSTEM_PROMPT).toMatch(/say which one is missing/);
	});

	it("tells file-deliverables apart from code-deliverables", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the file is the deliverable, not the code");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("do not paste base64");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the code is the deliverable");
	});

	it("routes text files to direct emission and binary ones to the sandbox", () => {
		// Two paths, one per file kind. The text path is verbatim emission: no
		// wrapper code, no sandbox — the block IS the file, which also makes it
		// ordinary message content that survives reload, export and share
		// links, unlike sandbox files that die with the page.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("There are two paths");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("you can author verbatim");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("```markdown title=report.md");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("the file itself, verbatim, with no code around it");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("do not wrap such a file in Python");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("downloadable file card");
		// The sandbox path keeps its contract, scoped to binary/computed files.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("binary or computed file");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("write it to the working directory");
		// The superseded single-path wording is gone: a file request must not
		// read as "always write Python that writes the file".
		expect(EXECUTION_SYSTEM_PROMPT).not.toContain(
			"the file is the deliverable, not the code: write it to the working directory"
		);
		expect(EXECUTION_SYSTEM_PROMPT).not.toContain("anything they will download or open");
		// The no-phantom-files rule survives the rewording, path-independent.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("only ever describe files you actually produced");
		expect(EXECUTION_SYSTEM_PROMPT).not.toContain(
			"Only ever describe files your code block actually wrote"
		);
	});

	it("keeps the standing code-block contract intact", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("executed automatically");
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"You do NOT see the code block's execution output yourself"
		);
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no network access");
	});

	it("prefers the vendored document packages over hand-built OOXML for binary files", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"using the format's proper package where one is available"
		);
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"rather than hand-built OOXML or stdlib zipfile surgery"
		);
	});

	it("describes the autonomous tool channel honestly", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("execute_code");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("You see the truncated stdout");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("Run, read the output, fix, run again");
		// The unavailable fallback: never claim results, fall back to a fence —
		// specifically a plain one with no `title=`, since that renders as a
		// downloadable file card of the source rather than a running block, and
		// without a Run button to point the person at (there is no such control;
		// the fence auto-runs, and unlike the tool it carries no park deadline).
		expect(EXECUTION_SYSTEM_PROMPT).toContain("execution environment is unavailable");
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"fall back to a plain fenced ```python code block with no `title=`"
		);
		expect(EXECUTION_SYSTEM_PROMPT).toContain("does not belong here");
		expect(EXECUTION_SYSTEM_PROMPT).not.toContain("Run button");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no timeout of its own");
	});

	it("warns against putting title= on Python meant to be executed", () => {
		// title= always names a file path regardless of language, so a
		// ```python title=script.py block renders as a downloadable source file,
		// never as something that runs — the same confusion the execute_code
		// fallback above must avoid.
		expect(EXECUTION_SYSTEM_PROMPT).toContain(
			"Never put `title=` on a Python block you want executed"
		);
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

	it("states which packages are installable and which need the person's opt-in", () => {
		// Rung (a): the vendored office packages (and anything else already in
		// this runtime's package lock) install same-origin, unconditionally.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("micropip.install(");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("python-docx");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("openpyxl");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("pypdf");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("python-pptx");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("numpy, pandas");
		// Rung (c): everything else on PyPI is gated on the person's own setting,
		// never framed as something they should install themselves.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("Install packages from PyPI");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("not proof the package doesn't exist");
		// Installing a package is not the same as reaching the network at run
		// time — that stays impossible regardless of which packages are in.
		expect(EXECUTION_SYSTEM_PROMPT).toContain("no sockets, no urllib, no requests to any URL");
	});

	it("teaches the self-healing doctrine: translate non-Python steps, prefer the real package", () => {
		expect(EXECUTION_SYSTEM_PROMPT).toContain("Self-healing");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("bash, a shell one-liner, Node");
		expect(EXECUTION_SYSTEM_PROMPT).toContain("translate it into equivalent Python");
	});

	it("injects the convention with the prompt", () => {
		expect(injectExecutionPrompt("Be brief.")).toContain("the file is the deliverable");
		expect(injectExecutionPrompt(undefined)).toContain("the file is the deliverable");
	});
});
