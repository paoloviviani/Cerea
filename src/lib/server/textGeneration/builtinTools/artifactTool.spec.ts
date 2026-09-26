import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$lib/server/database", () => ({
	collections: { conversations: { findOne: vi.fn() } },
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { collections } = await import("$lib/server/database");
const { ARTIFACT_TOOL_NAME, artifactToolDefinition, createArtifactTool, resolveArtifactOp } =
	await import("./artifactTool");
const { MessageUpdateType } = await import("$lib/types/MessageUpdate");

const findOne = collections.conversations.findOne as ReturnType<typeof vi.fn>;

beforeEach(() => {
	findOne.mockReset();
});

const msg = (id: string, content: string) => ({ id, from: "assistant" as const, content });

const CREATE_HTML = {
	command: "create",
	identifier: "snake-game",
	type: "html",
	title: "Snake Game",
	content: "<!doctype html><html><body>snake</body></html>",
} as const;

describe("artifact tool schema", () => {
	it("is one tool named artifact with a command enum", () => {
		expect(ARTIFACT_TOOL_NAME).toBe("artifact");
		expect(artifactToolDefinition.function.name).toBe("artifact");
		const params = artifactToolDefinition.function.parameters;
		expect(params.required).toEqual(["command"]);
		expect((params.properties as Record<string, { enum?: string[] }>).command.enum).toEqual([
			"create",
			"update",
			"rewrite",
		]);
	});

	it("declares every per-command field the contract needs", () => {
		const props = artifactToolDefinition.function.parameters.properties as Record<string, unknown>;
		for (const field of [
			"identifier",
			"type",
			"language",
			"title",
			"content",
			"old_str",
			"new_str",
		]) {
			expect(props[field], field).toBeDefined();
		}
		expect((props.type as { enum?: string[] }).enum).toEqual([
			"html",
			"react",
			"svg",
			"mermaid",
			"markdown",
			"code",
			"table",
		]);
	});

	it("describes itself without the inline tag grammar", () => {
		const desc: string = artifactToolDefinition.function.description;
		expect(desc).toContain("update");
		expect(desc).not.toContain("<artifact identifier=");
	});

	it("is exempt from the tool restraint and never parks", () => {
		const tool = createArtifactTool();
		expect(tool.exemptFromToolRestraint).toBe(true);
		expect(tool.mayPark).toBeUndefined();
	});
});

describe("resolveArtifactOp", () => {
	it("creates v1 with a canonical block", () => {
		const resolved = resolveArtifactOp([], { ...CREATE_HTML });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.version).toBe(1);
		expect(resolved.resultText).toBe("created snake-game v1 (html)");
		expect(resolved.block).toBe(
			`<artifact identifier="snake-game" type="html" title="Snake Game">${CREATE_HTML.content}</artifact>`
		);
	});

	it("creates a table artifact with a canonical block", () => {
		const resolved = resolveArtifactOp([], {
			command: "create",
			identifier: "sales",
			type: "table",
			title: "Sales",
			content: "month,amount\njan,10\nfeb,20",
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.version).toBe(1);
		expect(resolved.resultText).toBe("created sales v1 (table)");
		expect(resolved.block).toBe(
			`<artifact identifier="sales" type="table" title="Sales">month,amount\njan,10\nfeb,20</artifact>`
		);
	});

	it("rejects a create with an unknown type", () => {
		const resolved = resolveArtifactOp([], {
			command: "create",
			identifier: "sales",
			type: "spreadsheet",
			title: "Sales",
			content: "a,b",
		});
		expect(resolved.ok).toBe(false);
	});

	it("carries language for code artifacts only", () => {
		const withLang = resolveArtifactOp([], {
			command: "create",
			identifier: "cell",
			type: "code",
			language: "python",
			title: "Cell",
			content: "print(1)",
		});
		expect(withLang.ok).toBe(true);
		if (!withLang.ok) return;
		expect(withLang.block).toContain('language="python"');

		const htmlWithLang = resolveArtifactOp([], {
			command: "create",
			identifier: "page",
			type: "html",
			language: "python",
			title: "Page",
			content: "<html></html>",
		});
		expect(htmlWithLang.ok).toBe(true);
		if (!htmlWithLang.ok) return;
		expect(htmlWithLang.block).not.toContain("language=");
	});

	it("applies an update only when old_str matches exactly once", () => {
		const history = [
			msg(
				"m1",
				`<artifact identifier="doc" type="markdown" title="Doc">\nhello brave world\n</artifact>`
			),
		];
		const once = resolveArtifactOp(history, {
			command: "update",
			identifier: "doc",
			old_str: "brave",
			new_str: "new",
		});
		expect(once.ok).toBe(true);
		if (!once.ok) return;
		expect(once.version).toBe(2);
		expect(once.resultText).toBe("updated doc → v2");
		expect(once.block).toBe(
			`<artifact identifier="doc" type="update"><old_str>brave</old_str><new_str>new</new_str></artifact>`
		);
	});

	it("rejects an update with zero matches", () => {
		const history = [
			msg(
				"m1",
				`<artifact identifier="doc" type="markdown" title="Doc">\nhello world\n</artifact>`
			),
		];
		const resolved = resolveArtifactOp(history, {
			command: "update",
			identifier: "doc",
			old_str: "missing text",
			new_str: "x",
		});
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error).toContain("0 times");
		expect(resolved.error).toContain("exactly once");
	});

	it("rejects an update with two matches", () => {
		const history = [
			msg(
				"m1",
				`<artifact identifier="doc" type="markdown" title="Doc">\nrepeat repeat\n</artifact>`
			),
		];
		const resolved = resolveArtifactOp(history, {
			command: "update",
			identifier: "doc",
			old_str: "repeat",
			new_str: "x",
		});
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error).toContain("2 times");
	});

	it("rejects create on an existing identifier", () => {
		const history = [
			msg("m1", `<artifact identifier="doc" type="markdown" title="Doc">\nbody\n</artifact>`),
		];
		const resolved = resolveArtifactOp(history, { ...CREATE_HTML, identifier: "doc" });
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error).toContain("already exists");
		expect(resolved.error).toContain("rewrite");
	});

	it("rejects rewrite and update on an unknown identifier", () => {
		for (const args of [
			{ command: "rewrite" as const, identifier: "ghost", content: "x" },
			{ command: "update" as const, identifier: "ghost", old_str: "a", new_str: "b" },
		]) {
			const resolved = resolveArtifactOp([], args);
			expect(resolved.ok).toBe(false);
			if (resolved.ok) continue;
			expect(resolved.error).toContain("does not exist");
			expect(resolved.error).toContain("create");
		}
	});

	it("rejects content containing a literal closing tag", () => {
		const bad = "prefix </artifact> suffix";
		expect(resolveArtifactOp([], { ...CREATE_HTML, content: bad }).ok).toBe(false);
		const history = [
			msg("m1", `<artifact identifier="doc" type="markdown" title="Doc">\nbody\n</artifact>`),
		];
		expect(
			resolveArtifactOp(history, { command: "rewrite", identifier: "doc", content: bad }).ok
		).toBe(false);
		expect(
			resolveArtifactOp(history, {
				command: "update",
				identifier: "doc",
				old_str: "body",
				new_str: bad,
			}).ok
		).toBe(false);
	});

	it("numbers versions across messages", () => {
		const v1 = resolveArtifactOp([], { ...CREATE_HTML });
		expect(v1.ok && v1.version).toBe(1);
		if (!v1.ok) return;
		const history = [msg("m1", `intro\n\n${v1.block}\n\noutro`)];
		const rewrite = resolveArtifactOp(history, {
			command: "rewrite",
			identifier: "snake-game",
			content: "<html>v2</html>",
		});
		expect(rewrite.ok).toBe(true);
		if (!rewrite.ok) return;
		expect(rewrite.version).toBe(2);
		expect(rewrite.resultText).toBe("rewrote snake-game → v2");
		const history2 = [...history, msg("m2", rewrite.block)];
		const update = resolveArtifactOp(history2, {
			command: "update",
			identifier: "snake-game",
			old_str: "v2",
			new_str: "v3",
		});
		expect(update.ok).toBe(true);
		if (!update.ok) return;
		expect(update.version).toBe(3);
		expect(update.resultText).toBe("updated snake-game → v3");
	});

	it("sees blocks appended earlier in the same turn", async () => {
		findOne.mockResolvedValue({ messages: [] });
		const turnBlocks: string[] = [];
		const tool = createArtifactTool({ turnBlocks });
		const ctx = (messageId: string) => ({
			uuid: "u1",
			toolCallId: "call_1",
			conversationId: "conv" as never,
			messageId,
		});
		const created = await tool.execute({ ...CREATE_HTML }, ctx("m-live"));
		if (!("resultText" in created)) throw new Error("expected create to succeed");
		expect(created.resultText).toBe("created snake-game v1 (html)");
		// Same-turn update validates against the block above, not the database.
		const updated = await tool.execute(
			{ command: "update", identifier: "snake-game", old_str: "snake", new_str: "snek" },
			{ ...ctx("m-live"), toolCallId: "call_2", uuid: "u2" }
		);
		if (!("resultText" in updated))
			throw new Error(`expected update to succeed: ${JSON.stringify(updated)}`);
		expect(updated.resultText).toBe("updated snake-game → v2");
	});

	it("counts a same-turn block once when the live message is already stored with it", async () => {
		const turnBlocks: string[] = [];
		const tool = createArtifactTool({ turnBlocks });
		const ctx = {
			uuid: "u1",
			toolCallId: "call_1",
			conversationId: "conv" as never,
			messageId: "m-live",
		};
		findOne.mockResolvedValue({ messages: [] });
		await tool.execute({ ...CREATE_HTML }, ctx);
		// The route persisted the in-progress message with this turn's block in it.
		findOne.mockResolvedValue({ messages: [msg("m-live", `\n\n${turnBlocks[0]}`)] });
		const rewritten = await tool.execute(
			{ command: "rewrite", identifier: "snake-game", content: "<p>v2</p>" },
			{ ...ctx, toolCallId: "call_2", uuid: "u2" }
		);
		if (!("resultText" in rewritten)) throw new Error("expected rewrite to succeed");
		expect(rewritten.resultText).toBe("rewrote snake-game → v2");
	});

	it("appends the canonical block as a Stream extra update with a short result", async () => {
		findOne.mockResolvedValue({ messages: [] });
		const tool = createArtifactTool();
		const outcome = await tool.execute(
			{ ...CREATE_HTML },
			{ uuid: "u1", toolCallId: "call_1", conversationId: "conv" as never, messageId: "m1" }
		);
		if (!("resultText" in outcome)) throw new Error("expected success");
		expect(outcome.resultText).toBe("created snake-game v1 (html)");
		expect(outcome.resultText.length).toBeLessThan(60);
		expect(outcome.extraUpdates).toHaveLength(1);
		const extra = outcome.extraUpdates?.[0];
		expect(extra?.type).toBe(MessageUpdateType.Stream);
		if (extra?.type !== MessageUpdateType.Stream) return;
		expect(extra.token).toContain('<artifact identifier="snake-game"');
		expect(extra.token).toContain(CREATE_HTML.content);
	});

	it("returns a model-actionable error without appending on failure", async () => {
		findOne.mockResolvedValue({ messages: [] });
		const tool = createArtifactTool();
		const outcome = await tool.execute(
			{ command: "update", identifier: "ghost", old_str: "a", new_str: "b" },
			{ uuid: "u1", toolCallId: "call_1", conversationId: "conv" as never, messageId: "m1" }
		);
		expect("error" in outcome).toBe(true);
		expect("extraUpdates" in outcome).toBe(false);
	});

	it("rejects malformed arguments with a retryable error", async () => {
		const tool = createArtifactTool();
		const outcome = await tool.execute({ identifier: "x" }, { uuid: "u1", toolCallId: "call_1" });
		expect("error" in outcome).toBe(true);
	});
});
