import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ChatMessage from "./ChatMessage.svelte";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

const call = (uuid: string, name = "delegate") => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid,
	call: { name, parameters: { task: "do the thing" } },
});
const result = (uuid: string, text: string, name = "delegate") => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Result,
	uuid,
	result: {
		status: "success",
		call: { name, parameters: {} },
		outputs: [{ text }],
		display: true,
	},
});
const bash = (uuid: string) => [call(uuid, "bash"), result(uuid, "ok", "bash")];
const sub = (
	uuid: string,
	title: string,
	status: "running" | "done" = "running",
	activity?: string
) => ({
	type: MessageUpdateType.SubAgent,
	uuid,
	title,
	model: "Big One",
	status,
	...(activity ? { activity } : {}),
	steps: [],
});

const mount = (updates: unknown[], opts: { loading?: boolean; content?: string } = {}) =>
	render(ChatMessage, {
		message: {
			id: "m1",
			from: "assistant",
			content: opts.content ?? "Both are permissive.",
			children: [],
			updates,
		},
		loading: opts.loading ?? false,
		isLast: true,
		isAuthor: true,
		readOnly: false,
	} as never);

const text = (view: ReturnType<typeof mount>) => view.baseElement.textContent ?? "";
const cards = (view: ReturnType<typeof mount>) =>
	view.baseElement.querySelectorAll('[data-testid="subagent-card"]');

describe("sub-agent cards inside a message", () => {
	it("streaming: each sub-agent is its own card with a live line, and no 'Called' row for it", () => {
		const view = mount(
			[
				call("a"),
				call("b"),
				sub("a", "Licence of A", "running", "searching “A licence”"),
				sub("b", "Licence of B", "running", "reading b.test/license"),
			],
			{ loading: true, content: "" }
		);
		expect(cards(view)).toHaveLength(2);
		const out = text(view);
		expect(out).toContain("Licence of A");
		expect(out).toContain("Licence of B");
		expect(out).toContain("searching “A licence”");
		expect(out).toContain("reading b.test/license");
		expect(out).not.toContain("Called tool delegate");
		expect(out).not.toContain("Calling tool");
	});

	it("finished: the cards are not folded into 'Called N tools', and show their answers", () => {
		const view = mount([
			...bash("x"),
			call("a"),
			call("b"),
			sub("a", "Licence of A", "done"),
			sub("b", "Licence of B", "done"),
			result("a", "A is MIT."),
			result("b", "B is Apache-2.0."),
		]);
		expect(cards(view)).toHaveLength(2);
		const out = text(view);
		expect(out).toContain("A is MIT.");
		expect(out).toContain("B is Apache-2.0.");
		// the bash call keeps its own row; the delegate calls add no tool count to it
		expect(out).toContain("Called tool bash");
		expect(out).not.toContain("Called 3 tools");
	});

	it("a later state replaces the earlier card in place", () => {
		const view = mount([
			call("a"),
			sub("a", "Licence of A", "running", "searching"),
			sub("a", "Licence of A", "done"),
			result("a", "A is MIT."),
		]);
		expect(cards(view)).toHaveLength(1);
		expect(text(view)).toContain("Done");
		expect(text(view)).not.toContain("searching");
	});

	it("a call that failed before the sub-agent started keeps its ordinary error row", () => {
		const view = mount([
			call("a"),
			{
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: "a",
				message: "needs a task",
			},
		]);
		expect(cards(view)).toHaveLength(0);
		expect(text(view)).toContain("Error calling tool");
	});

	it("the research preset shows its card the same way", () => {
		const view = mount([
			call("r", "research"),
			{ ...sub("r", "Why is the sky blue", "done"), preset: "research" },
			result("r", "Rayleigh scattering.", "research"),
		]);
		expect(cards(view)).toHaveLength(1);
		expect(text(view)).toContain("Why is the sky blue");
		expect(text(view)).toContain("Rayleigh scattering.");
	});
});
