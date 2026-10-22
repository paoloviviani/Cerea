import { describe, expect, it } from "vitest";

import {
	ARTIFACT_TOOL_GUIDANCE,
	ARTIFACT_TOOL_POINTER,
	ARTIFACT_TOOL_RULE,
	ARTIFACTS_SYSTEM_PROMPT,
	artifactsEnabledForTurn,
	artifactsModeForTurn,
} from "./artifacts";
import { resolvePreprompt } from "./preprompt";
import { buildToolPreprompt } from "./utils/toolPrompt";
import { getEnabledBuiltinTools } from "./builtinTools/index";
import { ObjectId } from "mongodb";

const tool = (name: string) => ({
	type: "function" as const,
	function: { name, description: `${name} tool` },
});

describe("artifactsEnabledForTurn", () => {
	it("is opt-in per model with a user override", () => {
		expect(artifactsEnabledForTurn({ supportsArtifacts: true })).toBe(true);
		expect(artifactsEnabledForTurn({ supportsArtifacts: false })).toBe(false);
		expect(
			artifactsEnabledForTurn({
				supportsArtifacts: false,
				artifactsOverride: true,
			})
		).toBe(true);
		expect(
			artifactsEnabledForTurn({
				supportsArtifacts: true,
				artifactsOverride: false,
			})
		).toBe(false);
	});

	it("defaults to whether the model does tool calling, with no supportsArtifacts flag set", () => {
		// A tool-capable gateway model with no MODELS override at all — the
		// `glm-5.3-flash` case: on by default now, not off.
		expect(artifactsEnabledForTurn({ supportsTools: true })).toBe(true);
		// A model with no tool calling either: still off.
		expect(artifactsEnabledForTurn({ supportsTools: false })).toBe(false);
	});

	it("an explicit supportsArtifacts: false stays off even for a tool-capable model", () => {
		expect(artifactsEnabledForTurn({ supportsArtifacts: false, supportsTools: true })).toBe(false);
	});

	it("the user override wins over the tools-based default in both directions", () => {
		expect(artifactsEnabledForTurn({ supportsTools: false, artifactsOverride: true })).toBe(true);
		expect(artifactsEnabledForTurn({ supportsTools: true, artifactsOverride: false })).toBe(false);
	});
});

describe("artifactsModeForTurn", () => {
	it("defaults to tool when artifacts and tools are both on, else tags", () => {
		expect(artifactsModeForTurn({ supportsArtifacts: true, toolsEnabled: true })).toBe("tool");
		expect(artifactsModeForTurn({ supportsArtifacts: true, toolsEnabled: false })).toBe("tags");
		expect(artifactsModeForTurn({ supportsArtifacts: false, toolsEnabled: true })).toBe("tags");
	});

	it("lets an explicit per-model mode win", () => {
		expect(
			artifactsModeForTurn({
				supportsArtifacts: true,
				toolsEnabled: true,
				artifactsMode: "tags",
			})
		).toBe("tags");
		expect(
			artifactsModeForTurn({
				supportsArtifacts: false,
				toolsEnabled: false,
				artifactsMode: "tool",
			})
		).toBe("tool");
	});
});

describe("prompt gating", () => {
	it("drops the tag grammar in tool mode and keeps it in tags mode", () => {
		const base = "You are a pirate.";
		const toolMode = resolvePreprompt({
			conversationPreprompt: base,
			supportsArtifacts: true,
			forceTools: true,
		});
		expect(toolMode).toContain(base);
		expect(toolMode).not.toContain(ARTIFACTS_SYSTEM_PROMPT);
		expect(toolMode).not.toContain('<artifact identifier="kebab-case-id"');

		const tagsMode = resolvePreprompt({
			conversationPreprompt: base,
			supportsArtifacts: true,
			forceTools: false,
		});
		expect(tagsMode).toContain(ARTIFACTS_SYSTEM_PROMPT);
	});
});

describe("tool preprompt gating", () => {
	it("shows the tags rule in tags mode and the pointer in tool mode", () => {
		const tools = [tool("web_search_exa")];
		const tags = buildToolPreprompt(tools, undefined, undefined, {
			artifacts: true,
			artifactsMode: "tags",
		});
		expect(tags).toContain(ARTIFACT_TOOL_RULE);
		expect(tags).not.toContain(ARTIFACT_TOOL_POINTER);

		const toolMode = buildToolPreprompt(tools, undefined, undefined, {
			artifacts: false,
			artifactsMode: "tool",
		});
		expect(toolMode).toContain(ARTIFACT_TOOL_POINTER);
		expect(toolMode).not.toContain(ARTIFACT_TOOL_RULE);
	});
});

describe("markdown math support", () => {
	it("tells the model markdown artifacts render LaTeX, in tags mode and tool mode", () => {
		// The panel's markdown renderer is the chat pipeline (KaTeX), so both
		// surfaces must say so — checked here so a rewording cannot silently
		// drop the promise.
		expect(ARTIFACTS_SYSTEM_PROMPT).toContain("$inline$ and $$display$$");
		expect(ARTIFACT_TOOL_GUIDANCE).toContain("$inline$ and $$display$$");
	});

	it("documents the table type as CSV with a header row", () => {
		expect(ARTIFACTS_SYSTEM_PROMPT).toContain('"table"');
		expect(ARTIFACT_TOOL_GUIDANCE).toContain(
			'table" (tabular data as CSV with a header row; the user can sort, filter and download it)'
		);
	});
});

describe("artifact builtin enablement", () => {
	const conv = { _id: new ObjectId() };

	it("offers the tool when artifacts and tools are on", () => {
		const tools = getEnabledBuiltinTools({
			conv,
			artifactsOverride: true,
			modelArtifacts: { supportsArtifacts: true, supportsTools: true },
			toolsEnabled: true,
		});
		expect(tools.map((t) => t.name)).toContain("artifact");
	});

	it("withholds the tool in tags mode", () => {
		const tools = getEnabledBuiltinTools({
			conv,
			artifactsOverride: true,
			modelArtifacts: { supportsArtifacts: true, supportsTools: false },
			toolsEnabled: false,
		});
		expect(tools.map((t) => t.name)).not.toContain("artifact");
	});

	it("withholds the tool when artifacts are off", () => {
		const tools = getEnabledBuiltinTools({
			conv,
			modelArtifacts: { supportsArtifacts: false, supportsTools: true },
			toolsEnabled: true,
		});
		expect(tools.map((t) => t.name)).not.toContain("artifact");
	});
});
