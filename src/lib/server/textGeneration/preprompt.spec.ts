import { describe, expect, it } from "vitest";
import {
	composeUserPrompt,
	resolvePreprompt as resolveWithClock,
	type PrepromptInput,
} from "./preprompt";
import { injectArtifactsPrompt } from "./artifacts";
import { injectExecutionPrompt } from "./executionPrompt";

/**
 * Every prompt ends with the one current-time line
 * (`utils/clock.spec.ts` pins it). These cases are about everything *else* in
 * the prompt staying as it was, and the line moves by the minute, so it is
 * taken off here rather than frozen into every expectation.
 */
const resolvePreprompt = (input: PrepromptInput) =>
	resolveWithClock(input)?.replace(/\n\nCurrent date and time: [^\n]*$/, "");

/**
 * `legacy` is the plain artifacts expression, kept here verbatim so the matrix
 * is pinned to the current behaviour — the execution prompt is injected
 * unconditionally on top of it, since it is a client capability and never
 * per-model.
 */
const legacy = (
	conversationPreprompt: string | undefined,
	artifactsOverride: boolean | undefined,
	supportsArtifacts: boolean | undefined
) =>
	injectExecutionPrompt(
		(artifactsOverride ?? supportsArtifacts)
			? injectArtifactsPrompt(conversationPreprompt)
			: conversationPreprompt
	);

const PREPROMPTS = [undefined, "", "You are a pirate."];
const OVERRIDES = [undefined, true, false];
const SUPPORTS = [undefined, true, false];

describe("resolvePreprompt", () => {
	it("resolves every artifacts case as the plain expression does", () => {
		for (const conversationPreprompt of PREPROMPTS) {
			for (const artifactsOverride of OVERRIDES) {
				for (const supportsArtifacts of SUPPORTS) {
					expect(
						resolvePreprompt({
							conversationPreprompt,
							artifactsOverride,
							supportsArtifacts,
						}),
						`preprompt=${conversationPreprompt} override=${artifactsOverride} supports=${supportsArtifacts}`
					).toBe(legacy(conversationPreprompt, artifactsOverride, supportsArtifacts));
				}
			}
		}
	});

	it("still gives artifacts to a model that supports them", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			supportsArtifacts: true,
		});

		expect(resolved).toContain("You are a pirate.");
		expect(resolved).toBe(injectExecutionPrompt(injectArtifactsPrompt("You are a pirate.")));
	});

	it("still withholds artifacts from a model that does not support them", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				supportsArtifacts: false,
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("defaults on for a tool-capable model with no supportsArtifacts flag — in tool mode, so no tags in the prompt", () => {
		// The gateway-discovered case with no MODELS override — `glm-5.3-flash`,
		// say — where `supportsArtifacts` is genuinely absent, not `false`.
		// Artifacts are on, but tool mode carries the instructions on the tool
		// description instead of the tags grammar (see artifacts.spec.ts's
		// "prompt gating" for the tool-description side of this).
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				supportsTools: true,
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("falls back to inline tags when a tool-capable model's tools are off this turn", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				supportsTools: true,
				forceTools: false,
			})
		).toBe(injectExecutionPrompt(injectArtifactsPrompt("You are a pirate.")));
	});

	it("stays off for a non-tool model with no supportsArtifacts flag", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				supportsTools: false,
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("lets the per-model override win in both directions", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "base",
				artifactsOverride: false,
				supportsArtifacts: true,
			})
		).toBe(injectExecutionPrompt("base"));

		expect(
			resolvePreprompt({
				conversationPreprompt: "base",
				artifactsOverride: true,
				supportsArtifacts: false,
			})
		).toBe(injectExecutionPrompt(injectArtifactsPrompt("base")));
	});

	it("appends the skill context after the execution prompt it builds on", () => {
		const skills = "## Skills\n\n- `csv-shaping`: Reshape CSV.";
		const resolved = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			skillsPreprompt: skills,
		});
		expect(resolved).toContain("You are a pirate.");
		expect(resolved).toContain(skills);
		expect(resolved?.indexOf("## Code execution") ?? -1).toBeLessThan(
			resolved?.indexOf("## Skills") ?? Number.POSITIVE_INFINITY
		);
	});
});

describe("the person's own prompts: global, then custom model, then the conversation's", () => {
	it("composes them in that order, blank-line separated", () => {
		expect(
			composeUserPrompt({
				globalPrompt: "GLOBAL",
				customModelPrompt: "CUSTOM",
				conversationPreprompt: "CONVERSATION",
			})
		).toBe("GLOBAL\n\nCUSTOM\n\nCONVERSATION");
	});

	it("skips empty, whitespace-only and missing parts, leaving no stray blank lines", () => {
		expect(composeUserPrompt({ globalPrompt: "", customModelPrompt: "CUSTOM" })).toBe("CUSTOM");
		expect(
			composeUserPrompt({
				globalPrompt: "GLOBAL",
				customModelPrompt: "   \n ",
				conversationPreprompt: undefined,
			})
		).toBe("GLOBAL");
		expect(composeUserPrompt({})).toBe("");
		expect(composeUserPrompt({ conversationPreprompt: "CONVERSATION", globalPrompt: "\t" })).toBe(
			"CONVERSATION"
		);
	});

	it("puts them first in the turn's system prompt, ahead of every contract the turn adds", () => {
		const resolved =
			resolvePreprompt({
				globalPrompt: "GLOBAL",
				customModelPrompt: "CUSTOM",
				conversationPreprompt: "CONVERSATION",
				supportsArtifacts: true,
				skillsPreprompt: "SKILLS",
			}) ?? "";
		const at = (needle: string) => resolved.indexOf(needle);
		expect(at("GLOBAL")).toBe(0);
		expect(at("GLOBAL")).toBeLessThan(at("CUSTOM"));
		expect(at("CUSTOM")).toBeLessThan(at("CONVERSATION"));
		expect(at("CONVERSATION")).toBeLessThan(at(injectExecutionPrompt("").trim().slice(0, 40)));
		expect(at("CONVERSATION")).toBeLessThan(at("SKILLS"));
	});
});

describe("the opt-in location line", () => {
	const line = "The person's location (shared by them): Torino, Italy, timezone Europe/Rome.";

	it("reads after the global, custom-model and conversation prompts", () => {
		expect(
			composeUserPrompt({
				globalPrompt: "GLOBAL",
				customModelPrompt: "CUSTOM",
				conversationPreprompt: "CONVERSATION",
				locationLine: line,
			})
		).toBe(`GLOBAL\n\nCUSTOM\n\nCONVERSATION\n\n${line}`);
	});

	it("adds nothing when no line is given", () => {
		expect(composeUserPrompt({ globalPrompt: "GLOBAL" })).toBe("GLOBAL");
		expect(composeUserPrompt({})).toBe("");
	});

	it("sits in the turn's system prompt ahead of the contracts", () => {
		const resolved =
			resolvePreprompt({
				conversationPreprompt: "CONVERSATION",
				locationLine: line,
			}) ?? "";
		expect(resolved.indexOf("CONVERSATION")).toBeLessThan(resolved.indexOf(line));
		expect(resolved.indexOf(line)).toBeLessThan(
			resolved.indexOf(injectExecutionPrompt("").trim().slice(0, 40))
		);
	});
});

describe("the administrator's instructions", () => {
	it("come first, before the person's global prompt and everything after it", () => {
		const resolved =
			resolvePreprompt({
				adminInstructions: "ADMIN",
				globalPrompt: "GLOBAL",
				customModelPrompt: "CUSTOM",
				conversationPreprompt: "CONVERSATION",
				locationLine: "LOCATION",
			}) ?? "";
		expect(resolved.startsWith("ADMIN\n\nGLOBAL\n\nCUSTOM\n\nCONVERSATION\n\nLOCATION")).toBe(true);
		expect(resolved.indexOf("ADMIN")).toBeLessThan(
			resolved.indexOf(injectExecutionPrompt("").trim().slice(0, 40))
		);
	});

	it("are absent when empty or blank: no stray blank lines", () => {
		for (const adminInstructions of [undefined, "", "  \n "]) {
			expect(composeUserPrompt({ adminInstructions, globalPrompt: "GLOBAL" })).toBe("GLOBAL");
		}
		expect(composeUserPrompt({ adminInstructions: "ADMIN" })).toBe("ADMIN");
	});
});
