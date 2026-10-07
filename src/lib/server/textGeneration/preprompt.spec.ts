import { describe, expect, it } from "vitest";
import {
	composeUserPrompt,
	resolvePreprompt as resolveWithClock,
	type PrepromptInput,
} from "./preprompt";
import { injectArtifactsPrompt } from "./artifacts";
import { injectExecutionPrompt } from "./executionPrompt";
import {
	ML_ASSISTANT_BUDGET_RULES,
	ML_ASSISTANT_PREPROMPT,
	mlAssistantSessionContext,
} from "$lib/server/mlAssistantPrompt";

/**
 * Outside the ML preset every prompt now ends with the one current-time line
 * (`utils/clock.spec.ts` pins it). These cases are about everything *else* in
 * the prompt staying as it was, and the line moves by the minute, so it is
 * taken off here rather than frozen into every expectation.
 */
const resolvePreprompt = (input: PrepromptInput) =>
	resolveWithClock(input)?.replace(/\n\nCurrent date and time: [^\n]*$/, "");

/**
 * The ML Assistant preset must not change how artifacts resolve for anything
 * else. `legacy` is the expression this replaced, kept here verbatim so the
 * non-preset half of the matrix is pinned to the current behaviour — the
 * execution prompt is injected unconditionally on top of it, since it is a
 * client capability and never per-model.
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
	it("leaves every non-preset case exactly as it was before the preset existed", () => {
		for (const conversationPreprompt of PREPROMPTS) {
			for (const artifactsOverride of OVERRIDES) {
				for (const supportsArtifacts of SUPPORTS) {
					expect(
						resolvePreprompt({
							conversationPreprompt,
							mlAssistant: false,
							artifactsOverride,
							supportsArtifacts,
						}),
						`preprompt=${conversationPreprompt} override=${artifactsOverride} supports=${supportsArtifacts}`
					).toBe(legacy(conversationPreprompt, artifactsOverride, supportsArtifacts));
				}
			}
		}
	});

	it("still gives artifacts to a model that supports them, with no preset in sight", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			mlAssistant: false,
			supportsArtifacts: true,
		});

		expect(resolved).toContain("You are a pirate.");
		expect(resolved).toBe(injectExecutionPrompt(injectArtifactsPrompt("You are a pirate.")));
		expect(resolved).not.toContain(ML_ASSISTANT_PREPROMPT);
	});

	it("still withholds artifacts from a model that does not support them", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				mlAssistant: false,
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
				mlAssistant: false,
				supportsTools: true,
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("falls back to inline tags when a tool-capable model's tools are off this turn", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				mlAssistant: false,
				supportsTools: true,
				forceTools: false,
			})
		).toBe(injectExecutionPrompt(injectArtifactsPrompt("You are a pirate.")));
	});

	it("stays off for a non-tool model with no supportsArtifacts flag", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				mlAssistant: false,
				supportsTools: false,
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("lets the per-model override win in both directions outside the preset", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "base",
				mlAssistant: false,
				artifactsOverride: false,
				supportsArtifacts: true,
			})
		).toBe(injectExecutionPrompt("base"));

		expect(
			resolvePreprompt({
				conversationPreprompt: "base",
				mlAssistant: false,
				artifactsOverride: true,
				supportsArtifacts: false,
			})
		).toBe(injectExecutionPrompt(injectArtifactsPrompt("base")));
	});

	it("replaces the conversation prompt with the preset, not per model", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			mlAssistant: true,
			supportsArtifacts: false,
		});

		expect(resolved).toContain(ML_ASSISTANT_PREPROMPT);
		expect(resolved).not.toContain("You are a pirate.");
	});

	it("force-enables artifacts for the preset even when the model and override say no", () => {
		const now = new Date("2026-08-24T09:07:00Z");

		expect(
			resolvePreprompt({
				conversationPreprompt: undefined,
				mlAssistant: true,
				artifactsOverride: false,
				supportsArtifacts: false,
				timezone: "UTC",
				now,
			})
		).toBe(
			`${injectExecutionPrompt(injectArtifactsPrompt(ML_ASSISTANT_PREPROMPT))}\n\n${ML_ASSISTANT_BUDGET_RULES}\n\n${mlAssistantSessionContext(
				{
					timezone: "UTC",
					now,
					budget: { remaining: "$0.00", total: "$0.00" },
				}
			)}`
		);
	});

	it("stamps the session context last, where the namespace rule reads it", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			username: "pngwn",
			timezone: "UTC",
			now: new Date("2026-08-24T09:07:00Z"),
		});

		expect(resolved).toContain("User=pngwn");
		// The bracketed context stays the message's final line: the namespace rule
		// keys off it, and artifacts is appended by the same call.
		expect(resolved?.trimEnd().endsWith("]")).toBe(true);
		expect(resolved?.trimEnd().split("\n").at(-1)).toContain("User=pngwn");
	});

	it("says the user is unknown rather than leaving the preset to guess", () => {
		expect(resolvePreprompt({ conversationPreprompt: undefined, mlAssistant: true })).toContain(
			"User=unknown"
		);
	});

	it("appends the skill context after the execution prompt it builds on", () => {
		const skills = "## Skills\n\n- `csv-shaping`: Reshape CSV.";
		const resolved = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			mlAssistant: false,
			skillsPreprompt: skills,
		});
		expect(resolved).toContain("You are a pirate.");
		expect(resolved).toContain(skills);
		expect(resolved?.indexOf("## Code execution") ?? -1).toBeLessThan(
			resolved?.indexOf("## Skills") ?? Number.POSITIVE_INFINITY
		);
	});

	it("keeps the skill context ahead of the preset's trailing budget lines", () => {
		const skills = "## Skills\n\n- `csv-shaping`: Reshape CSV.";
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			username: "pngwn",
			timezone: "UTC",
			now: new Date("2026-08-24T09:07:00Z"),
			skillsPreprompt: skills,
		});
		expect(resolved).toContain(skills);
		expect(resolved?.indexOf("## Skills") ?? -1).toBeLessThan(
			resolved?.indexOf("# Session budget") ?? Number.POSITIVE_INFINITY
		);
	});

	it("stamps nothing outside the preset", () => {
		expect(
			resolvePreprompt({
				conversationPreprompt: "You are a pirate.",
				mlAssistant: false,
				username: "pngwn",
			})
		).toBe(injectExecutionPrompt("You are a pirate."));
	});

	it("carries the live balance in the session context", () => {
		const budget = {
			totalMicroUsd: 10_000_000,
			spentMicroUsd: 1_500_000,
			reservations: [
				{
					key: "gen:a",
					kind: "job" as const,
					flavor: "t4-small",
					priceMicroUsdPerMinute: 6667,
					timeoutSeconds: 600,
					ceilingMicroUsd: 1_000_000,
					createdAt: new Date(),
				},
			],
		};
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			username: "pngwn",
			budget,
		});
		expect(resolved).toContain("# Session budget");
		// total − spent − held = 10.00 − 1.50 − 1.00
		expect(resolved).toContain("Budget=$7.50 remaining of $10.00");
	});

	it("treats a conversation without a stored budget as a zero grant, not an ungated one", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			username: "pngwn",
		});
		expect(resolved).toContain("# Session budget");
		expect(resolved).toContain("Budget=$0.00 remaining of $0.00");

		const outsideMode = resolvePreprompt({
			conversationPreprompt: "You are a pirate.",
			mlAssistant: false,
		});
		expect(outsideMode).not.toContain("# Session budget");
		expect(outsideMode).not.toContain("Budget=");
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
				mlAssistant: false,
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

	it("never reaches the ML Assistant preset, which supplies the whole prompt", () => {
		const resolved =
			resolvePreprompt({
				globalPrompt: "GLOBAL",
				customModelPrompt: "CUSTOM",
				mlAssistant: true,
				username: "pngwn",
			}) ?? "";
		expect(resolved).not.toContain("GLOBAL");
		expect(resolved).not.toContain("CUSTOM");
	});
});
