import { describe, expect, it, vi } from "vitest";

// The gate itself is real; only the build flag behind it is forced on.
vi.mock("$lib/utils/mlAssistantFlag", () => ({ ML_ASSISTANT_MODE: true }));

import {
	ARTIFACT_TOOL_POINTER,
	ARTIFACT_TOOL_RULE,
	ARTIFACTS_SYSTEM_PROMPT,
	artifactsEnabledForTurn,
	artifactsModeForTurn,
} from "./artifacts";
import { resolvePreprompt } from "./preprompt";
import { buildToolPreprompt } from "./utils/toolPrompt";
import { createArtifactTool } from "./builtinTools/artifactTool";
import { getEnabledBuiltinTools } from "./builtinTools/index";
import { ObjectId } from "mongodb";

const tool = (name: string) => ({
	type: "function" as const,
	function: { name, description: `${name} tool` },
});

describe("artifactsEnabledForTurn", () => {
	it("force-enables for the ML preset", () => {
		expect(artifactsEnabledForTurn({ mlAssistant: true })).toBe(true);
		expect(
			artifactsEnabledForTurn({
				mlAssistant: true,
				artifactsOverride: false,
				supportsArtifacts: false,
			})
		).toBe(true);
	});

	it("is opt-in per model with a user override outside the preset", () => {
		expect(artifactsEnabledForTurn({ mlAssistant: false, supportsArtifacts: true })).toBe(true);
		expect(artifactsEnabledForTurn({ mlAssistant: false, supportsArtifacts: false })).toBe(false);
		expect(
			artifactsEnabledForTurn({
				mlAssistant: false,
				supportsArtifacts: false,
				artifactsOverride: true,
			})
		).toBe(true);
		expect(
			artifactsEnabledForTurn({
				mlAssistant: false,
				supportsArtifacts: true,
				artifactsOverride: false,
			})
		).toBe(false);
	});

	it("defaults to whether the model does tool calling, with no supportsArtifacts flag set", () => {
		// A tool-capable gateway model with no MODELS override at all — the
		// `glm-5.3-flash` case: on by default now, not off.
		expect(artifactsEnabledForTurn({ mlAssistant: false, supportsTools: true })).toBe(true);
		// A model with no tool calling either: still off.
		expect(artifactsEnabledForTurn({ mlAssistant: false, supportsTools: false })).toBe(false);
	});

	it("an explicit supportsArtifacts: false stays off even for a tool-capable model", () => {
		expect(
			artifactsEnabledForTurn({ mlAssistant: false, supportsArtifacts: false, supportsTools: true })
		).toBe(false);
	});

	it("the user override wins over the tools-based default in both directions", () => {
		expect(
			artifactsEnabledForTurn({ mlAssistant: false, supportsTools: false, artifactsOverride: true })
		).toBe(true);
		expect(
			artifactsEnabledForTurn({ mlAssistant: false, supportsTools: true, artifactsOverride: false })
		).toBe(false);
	});
});

describe("artifactsModeForTurn", () => {
	it("defaults to tool when artifacts and tools are both on, else tags", () => {
		expect(
			artifactsModeForTurn({ mlAssistant: false, supportsArtifacts: true, toolsEnabled: true })
		).toBe("tool");
		expect(
			artifactsModeForTurn({ mlAssistant: false, supportsArtifacts: true, toolsEnabled: false })
		).toBe("tags");
		expect(
			artifactsModeForTurn({ mlAssistant: false, supportsArtifacts: false, toolsEnabled: true })
		).toBe("tags");
	});

	it("applies tool mode in the ML preset when the model supports tools", () => {
		expect(artifactsModeForTurn({ mlAssistant: true, toolsEnabled: true })).toBe("tool");
		expect(artifactsModeForTurn({ mlAssistant: true, toolsEnabled: false })).toBe("tags");
	});

	it("lets an explicit per-model mode win", () => {
		expect(
			artifactsModeForTurn({
				mlAssistant: false,
				supportsArtifacts: true,
				toolsEnabled: true,
				artifactsMode: "tags",
			})
		).toBe("tags");
		expect(
			artifactsModeForTurn({
				mlAssistant: false,
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
			mlAssistant: false,
			supportsArtifacts: true,
			forceTools: true,
		});
		expect(toolMode).toContain(base);
		expect(toolMode).not.toContain(ARTIFACTS_SYSTEM_PROMPT);
		expect(toolMode).not.toContain('<artifact identifier="kebab-case-id"');

		const tagsMode = resolvePreprompt({
			conversationPreprompt: base,
			mlAssistant: false,
			supportsArtifacts: true,
			forceTools: false,
		});
		expect(tagsMode).toContain(ARTIFACTS_SYSTEM_PROMPT);
	});

	it("keeps the tags grammar for the ML preset when the model lacks tools", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			supportsTools: false,
		});
		expect(resolved).toContain(ARTIFACTS_SYSTEM_PROMPT);
	});

	it("drops the grammar for the ML preset when the model supports tools", () => {
		const resolved = resolvePreprompt({
			conversationPreprompt: undefined,
			mlAssistant: true,
			supportsTools: true,
		});
		expect(resolved).not.toContain(ARTIFACTS_SYSTEM_PROMPT);
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

	it("offers the tool in the ML preset when the model supports tools", () => {
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), mlAssistant: true },
			modelArtifacts: { supportsArtifacts: false, supportsTools: true },
			toolsEnabled: true,
		});
		expect(tools.map((t) => t.name)).toContain("artifact");
		const description = createArtifactTool().definition.function.description;
		expect(description).toBeDefined();
		expect(description?.length).toBeGreaterThan(200);
	});
});
