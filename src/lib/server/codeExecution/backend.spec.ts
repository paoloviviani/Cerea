import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ exec: "", tool: "" }));
const warn = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/logger", () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		get config() {
			return new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (prop === "CHAT_CODE_EXECUTION") return state.exec;
					if (prop === "CHAT_CODE_TOOL_ENABLED") return state.tool;
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import { executionBackend, parseExecutionSetting, resetExecutionBackendWarning } from "./backend";
import { createExecuteCodeBuiltin } from "$lib/server/textGeneration/builtinTools/executeCodeTool";
import { resolvePreprompt } from "$lib/server/textGeneration/preprompt";

beforeEach(() => {
	state.exec = "";
	state.tool = "true";
	warn.mockClear();
	resetExecutionBackendWarning();
});

describe("execution backend configuration", () => {
	it("parses the setting, reading unknown values as the default", () => {
		expect(parseExecutionSetting(undefined)).toBe("browser");
		expect(parseExecutionSetting("")).toBe("browser");
		expect(parseExecutionSetting(" Browser ")).toBe("browser");
		expect(parseExecutionSetting("off")).toBe("off");
		expect(parseExecutionSetting("server")).toBe("server");
		expect(parseExecutionSetting("nonsense")).toBe("browser");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("is the browser backend by default, with the tool gated by the older flag", () => {
		expect(executionBackend().kind).toBe("browser");
		expect(createExecuteCodeBuiltin()).toHaveLength(1);
		state.tool = "";
		expect(executionBackend().kind).toBe("browser");
		expect(createExecuteCodeBuiltin()).toHaveLength(0);
	});

	it("off removes the tool and the prompt's execution wording", () => {
		state.exec = "off";
		expect(executionBackend().enabled).toBe(false);
		expect(createExecuteCodeBuiltin()).toHaveLength(0);
		const prompt = resolvePreprompt({}) ?? "";
		expect(prompt).toContain("Python cannot be run in this app");
		expect(prompt).not.toContain("Pyodide");
	});

	it("server has no implementation: it warns once and behaves as off", () => {
		state.exec = "server";
		expect(executionBackend().kind).toBe("off");
		expect(executionBackend().kind).toBe("off");
		expect(createExecuteCodeBuiltin()).toHaveLength(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("no implementation");
	});

	it("the browser backend names its engine in the prompt", () => {
		expect(resolvePreprompt({}) ?? "").toContain("in the person's browser (Pyodide");
	});
});
