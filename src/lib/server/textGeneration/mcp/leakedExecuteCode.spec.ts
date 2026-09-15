import { describe, expect, it, vi } from "vitest";

// The module under test is pure; the mocks only keep executeCodeTool's
// transitive imports (config, database, logger) from leaving the process.
vi.mock("$lib/server/config", () => ({ config: {} }));
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { recoverLeakedExecuteCodeCall } = await import("./leakedExecuteCode");

const offered = { toolOffered: true };

const block = (code: string) => `<execute_code lang="python">\n${code}\n</execute_code>`;

describe("recoverLeakedExecuteCodeCall", () => {
	it("parses one well-formed block into an execute_code tool call", () => {
		const call = recoverLeakedExecuteCodeCall({
			content: `Counting now.\n\n${block("print(1 + 1)")}`,
			...offered,
		});

		expect(call).not.toBeNull();
		expect(call?.name).toBe("execute_code");
		expect(call?.id).toBeTruthy();
		expect(JSON.parse(call?.arguments ?? "")).toEqual({ code: "print(1 + 1)" });
	});

	it("accepts a tag with no attributes and trims the code", () => {
		const call = recoverLeakedExecuteCodeCall({
			content: `<execute_code>  \nprint(2)\n  </execute_code>`,
			...offered,
		});

		expect(JSON.parse(call?.arguments ?? "")).toEqual({ code: "print(2)" });
	});

	it("refuses when the tool was not offered this run", () => {
		// A markup imitation of a tool the model was never given is not a call
		// to honor; recovering it would execute code on the strength of a name.
		expect(
			recoverLeakedExecuteCodeCall({ content: block("print(1)"), toolOffered: false })
		).toBeNull();
	});

	it("refuses a block inside a fenced code block", () => {
		// Illustration, not an attempt: the fence channel already runs fenced
		// code for the person on its own terms.
		const content = `Here is the shape of it:\n\n\`\`\`python\n${block("print(1)")}\n\`\`\`\n`;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).toBeNull();
	});

	it("refuses a block after an unterminated fence opener", () => {
		// A renderer would render everything past the opener as code, so an
		// attempt the reader cannot tell apart from an example does not run.
		const content = `Example:\n\n\`\`\`python\nprint(0)\n\n${block("print(1)")}`;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).toBeNull();
	});

	it("refuses a single-line block inside an inline code span", () => {
		const content = `like so: \`${block("print(1)").replace(/\n/g, " ")}\` — that is the syntax.`;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).toBeNull();
	});

	it("does not treat a backtick span crossing lines as quoting", () => {
		// Inline code spans cannot cross lines in markdown, so backticks around a
		// multi-line block are not quoting a renderer would honor — the markup is
		// already broken on the page. Stripping them here would invent a rule no
		// renderer applies, and the block below is exactly the live failure
		// shape, so it recovers.
		const content = `like so: \`${block("print(1)")}\` — that is the syntax.`;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).not.toBeNull();
	});

	it("refuses two well-formed blocks as ambiguity", () => {
		// Running the first and silently dropping the second would fabricate a
		// success the code never had; ambiguity does nothing.
		const content = `First:\n\n${block("print(1)")}\n\nThen:\n\n${block("print(2)")}`;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).toBeNull();
	});

	it("recovers the one block outside a fence when an example sits in a fence", () => {
		const content = `Like this:\n\n\`\`\`\n${block("print(0)")}\n\`\`\`\n\nSo:\n\n${block("print(1)")}`;
		const call = recoverLeakedExecuteCodeCall({ content, ...offered });

		expect(JSON.parse(call?.arguments ?? "")).toEqual({ code: "print(1)" });
	});

	it("refuses an opening tag with no closing tag", () => {
		expect(
			recoverLeakedExecuteCodeCall({
				content: `<execute_code lang="python">\nprint(1)`,
				...offered,
			})
		).toBeNull();
	});

	it("refuses an empty block", () => {
		expect(
			recoverLeakedExecuteCodeCall({ content: "<execute_code></execute_code>", ...offered })
		).toBeNull();
	});

	it("refuses a whole-reply fence even when the block is inside it", () => {
		const content = `\`\`\`\n${block("print(1)")}\n\`\`\``;
		expect(recoverLeakedExecuteCodeCall({ content, ...offered })).toBeNull();
	});
});
