import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ exec: "", tool: "", usable: false }));
const warn = vi.hoisted(() => vi.fn());

vi.mock("./sandboxHealth", () => ({
	sandboxUsable: () => state.usable,
	probeSandboxHealth: async () => state.usable,
	sandboxHealthyNow: async () => state.usable,
}));
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
import {
	codeResumeResultText,
	createExecuteCodeBuiltin,
} from "$lib/server/textGeneration/builtinTools/executeCodeTool";
import type { ParkedCall } from "$lib/types/ParkedCall";
import { resolvePreprompt } from "$lib/server/textGeneration/preprompt";

beforeEach(() => {
	state.exec = "";
	state.tool = "true";
	state.usable = false;
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

	it("server falls back to the browser, logged once, when sandboxes are off or unhealthy", () => {
		state.exec = "server";
		expect(executionBackend().kind).toBe("browser");
		expect(executionBackend().kind).toBe("browser");
		expect(createExecuteCodeBuiltin()).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("sandbox manager is off or not answering");
	});

	it("server is the server backend while the manager answers, and falls back again when it stops", () => {
		state.exec = "server";
		state.usable = true;
		expect(executionBackend().kind).toBe("server");
		expect(createExecuteCodeBuiltin()).toHaveLength(1);
		expect(warn).not.toHaveBeenCalled();
		state.usable = false;
		expect(executionBackend().kind).toBe("browser");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("describes the tool for the engine that runs it, with the same name and arguments", () => {
		const browser = createExecuteCodeBuiltin()[0].definition.function;
		state.exec = "server";
		state.usable = true;
		const server = createExecuteCodeBuiltin()[0].definition.function;
		expect(server.name).toBe(browser.name);
		expect(server.parameters).toEqual(browser.parameters);
		expect(browser.description).toContain("browser sandbox");
		expect(server.description).toContain("server");
		expect(server.description).toContain("NO network");
		expect(server.description).not.toContain("micropip");
	});

	it("words the result for a server run, with the restart notice", () => {
		const park = {
			parkedCallId: "p",
			outcome: {
				ok: true,
				stdout: "1\n",
				stderr: "",
				files: [],
				engine: "server",
				notice: "The server sandbox was restarted since your last call",
			},
		} as unknown as ParkedCall;
		const text = codeResumeResultText(park, false);
		expect(text).toContain("Execution finished in the server sandbox.");
		expect(text).toContain("NOTE: The server sandbox was restarted");
		expect(text).not.toContain("browser");
		const silent = codeResumeResultText(
			{ parkedCallId: "p", reason: "code execution in a server sandbox" } as unknown as ParkedCall,
			false
		);
		expect(silent).toContain("The server sandbox gave no answer");
	});

	it("the browser backend names its engine in the prompt", () => {
		expect(resolvePreprompt({}) ?? "").toContain("in the person's browser (Pyodide");
	});
});
