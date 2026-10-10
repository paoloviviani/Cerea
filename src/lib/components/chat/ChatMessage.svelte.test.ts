import ChatMessage from "./ChatMessage.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

const call = (uuid: string) => ({
	type: "tool",
	subtype: "call",
	uuid,
	call: { name: "ask_user_question", parameters: {} },
});
const result = (uuid: string) => ({
	type: "tool",
	subtype: "result",
	uuid,
	result: {
		status: 0,
		call: { name: "ask_user_question", parameters: {} },
		outputs: [{ text: "The user answered: S3" }],
		display: true,
	},
});
const answeredQuestion = [
	{
		type: "elicitation",
		subtype: "request",
		toolUuid: "u1",
		request: {
			elicitationId: "e1",
			source: "assistant",
			server: "",
			mode: "form",
			message: "",
			fields: [
				{
					kind: "select",
					name: "q1",
					title: "Storage",
					description: "Where should uploads go?",
					required: true,
					multiple: false,
					options: [{ value: "S3", label: "S3" }],
				},
			],
		},
	},
	{
		type: "elicitation",
		subtype: "resolved",
		elicitationId: "e1",
		action: "accept",
		resolution: "user",
		content: { q1: "S3" },
	},
];

const mount = (updates: unknown[], content = "") =>
	render(ChatMessage, {
		message: { id: "m1", from: "assistant", content, children: [], updates },
		loading: true,
		isLast: true,
		isAuthor: true,
		readOnly: false,
	} as never);

const spinners = (el: HTMLElement) => el.querySelectorAll(".loading").length;

describe("a run still working with nothing streaming", () => {
	// One mount per test: they share a document, so a second would count the first's.
	it("says so after a question has been answered", () => {
		// The settled row is all there is while the call restarts, and it does not animate.
		expect(spinners(mount([call("u1"), ...answeredQuestion]).baseElement)).toBe(1);
	});

	it("says so while the model thinks after a tool has finished", () => {
		expect(spinners(mount([call("u1"), result("u1"), ...answeredQuestion]).baseElement)).toBe(1);
	});

	it("adds nothing while reasoning streams, which shows its own progress", () => {
		// An unclosed <think> is reasoning still arriving; it animates itself without this
		// class, so anything here would be ours doubling up.
		const { baseElement } = mount([], "<think>weighing the options");
		expect(spinners(baseElement)).toBe(0);
	});
});

describe("the progress mark", () => {
	// One mount per test: they share a document.
	it("is the animated mountain alone, with no bubble, before anything arrives", () => {
		const { baseElement } = mount([]);
		const marks = baseElement.querySelectorAll('svg[aria-label="Generating response"]');
		expect(marks).toHaveLength(1);
		expect(marks[0].classList.contains("loading")).toBe(true);
		// The three dots are gone, and so is the empty bubble around the mark.
		expect(baseElement.querySelectorAll(".animate-bounce")).toHaveLength(0);
		expect(baseElement.querySelector('[data-message-role="assistant"] .rounded-2xl')).toBeNull();
	});

	it("leaves no avatar column beside a finished answer", () => {
		const { baseElement } = render(ChatMessage, {
			message: { id: "m2", from: "assistant", content: "Done.", children: [], updates: [] },
			loading: false,
			isLast: true,
			isAuthor: true,
			readOnly: false,
		} as never);
		expect(baseElement.querySelectorAll('svg[aria-label="Assistant response"]')).toHaveLength(0);
	});
});

describe("collapsed process blocks during streaming", () => {
	const stream = (token: string) => ({ type: "stream", token });
	const streamCall = (uuid: string) => ({
		type: "tool",
		subtype: "call",
		uuid,
		call: { name: "hf_fs", parameters: {} },
	});
	const streamResult = (uuid: string) => ({
		type: "tool",
		subtype: "result",
		uuid,
		result: {
			status: 0,
			call: { name: "hf_fs", parameters: {} },
			outputs: [{ text: "ok" }],
			display: true,
		},
	});
	const expanded = (el: HTMLElement) => el.querySelectorAll('button[aria-label="Collapse"]');

	it("never expands more than the active block, even after a lost think closer", async () => {
		// Round 1's reasoning never receives its </think> (the closer can get lost
		// when tool-call deltas mute the content stream server-side). That stale
		// block must not shimmer or re-expand each time a later block goes active.
		const steps = [
			stream("<think>Reading the repo"),
			streamCall("u1"),
			streamResult("u1"),
			stream("Let me dig into the README."),
			stream("<think>Checking metadata</think>"),
			streamCall("u2"),
			streamResult("u2"),
			stream("Grabbing the repo metadata too."),
			stream("<think>Final synthesis"),
		];

		const updates: unknown[] = [];
		const screen = mount([]);
		for (const step of steps) {
			updates.push(step);
			await screen.rerender({
				message: { id: "m1", from: "assistant", content: "", children: [], updates: [...updates] },
			} as never);
			await tick();
			expect(expanded(screen.baseElement as HTMLElement).length).toBeLessThanOrEqual(1);
		}

		// The active think block streams at the end; it alone is expanded.
		const open = expanded(screen.baseElement as HTMLElement);
		expect(open.length).toBe(1);
		expect(open[0].textContent).toContain("Thinking");
	});

	it("keeps the flat rows through mid-turn narration instead of regrouping them", async () => {
		// Models narrate between tool rounds. That text must not collapse the
		// previous rows into the "Called N tools" summary mid-turn: the next
		// round would explode the summary back into rows, which reads as the
		// collapsed blocks re-expanding. Grouping belongs to the finished turn.
		const steps = [
			streamCall("u1"),
			streamResult("u1"),
			streamCall("u2"),
			streamResult("u2"),
			stream("This is excellent research. Let me search more."),
			streamCall("u3"),
			streamResult("u3"),
			stream("Now I have comprehensive data."),
			streamCall("u4"),
		];
		const summaries = (el: HTMLElement) =>
			[...el.querySelectorAll("button")].filter((b) =>
				/^Called \d+ tools?/.test(b.textContent?.trim() ?? "")
			);
		const toolRows = (el: HTMLElement) => el.querySelectorAll("code").length;

		const updates: unknown[] = [];
		const screen = mount([]);
		let previousRows = 0;
		for (const step of steps) {
			updates.push(step);
			await screen.rerender({
				message: { id: "m1", from: "assistant", content: "", children: [], updates: [...updates] },
			} as never);
			await tick();
			const el = screen.baseElement as HTMLElement;
			expect(summaries(el).length).toBe(0);
			expect(toolRows(el)).toBeGreaterThanOrEqual(previousRows);
			previousRows = toolRows(el);
		}

		// Once the turn is over, the finished-turn grouping takes over.
		await screen.rerender({ loading: false } as never);
		await tick();
		expect(summaries(screen.baseElement as HTMLElement).length).toBeGreaterThan(0);
	});
});

describe("a row arriving inside a streaming text part", () => {
	const stream = (token: string, partId: string) => ({ type: "stream", token, partId });
	const permissionAsked = {
		type: "elicitation",
		subtype: "request",
		request: {
			elicitationId: "perm1",
			server: "bash",
			mode: "form",
			message: "Subagent Dummy sleep test wants to call bash",
			toolApproval: { tool: "bash", args: { command: "sleep 60" } },
			childSessionId: "ses_child",
			childTitle: "Dummy sleep test",
		},
	};

	it("keeps an inline code span whole and puts the row after the text", () => {
		// The parent's sentence is mid-stream when the child's approval arrives.
		const { baseElement } = mount([
			stream("Background task launched (id `ses_ef2e958", "p1"),
			permissionAsked,
			stream("05ffe80E5LI9BTLxQJ2`) — it will sleep 60s.", "p1"),
		]);
		const text = baseElement.textContent ?? "";
		// The id is one run of text: no row between its halves.
		expect(text).toContain("ses_ef2e95805ffe80E5LI9BTLxQJ2");
		expect(text.indexOf("it will sleep 60s")).toBeLessThan(
			text.indexOf("Subagent Dummy sleep test")
		);
	});

	it("still gives a later part its own block after the row", () => {
		const { baseElement } = mount([
			stream("First part.", "p1"),
			permissionAsked,
			stream("Second part.", "p2"),
		]);
		const text = baseElement.textContent ?? "";
		expect(text.indexOf("First part.")).toBeLessThan(text.indexOf("Subagent Dummy sleep test"));
		expect(text.indexOf("Subagent Dummy sleep test")).toBeLessThan(text.indexOf("Second part."));
	});
});

describe("a final answer after tools", () => {
	const stream = (token: string) => ({ type: "stream", token });

	it("renders the answer once when the stream has a step break the final text lacks", () => {
		// Narration, a tool, then the answer streamed after the server's step
		// break; the provider's final text is the answer without that break.
		const answer = "## In sintesi\n\n- **Sì**, puoi fruire dei riposi dalla nascita.";
		const { baseElement } = render(ChatMessage, {
			message: {
				id: "m1",
				from: "assistant",
				content: "",
				children: [],
				updates: [
					stream("Verifico le fonti."),
					call("u1"),
					result("u1"),
					stream("\n\nHo completato la ricerca.\n\n" + answer),
					{ type: "finalAnswer", text: "Ho completato la ricerca." + answer },
				],
			},
			loading: false,
			isLast: true,
			isAuthor: true,
			readOnly: false,
		} as never);
		const text = baseElement.textContent ?? "";
		expect(text.split("puoi fruire dei riposi").length - 1).toBe(1);
		expect(text.split("Ho completato la ricerca").length - 1).toBe(1);
	});
});

describe("a failed turn says why, on the turn itself", () => {
	const turnState = (state: string, reason?: string) => ({
		type: "turnState",
		state,
		serverNow: 0,
		...(reason ? { reason } : {}),
	});

	it("shows the framed provider refusal, hint included, where the turn died", () => {
		const { baseElement } = mount([
			turnState(
				"failed",
				"The model's provider refused the request: AuthenticationError: Insufficient Balance." +
					" Check the provider's credit or key, or switch model."
			),
		]);
		const banner = baseElement.querySelector('[data-testid="turn-failed-reason"]');
		expect(banner).toBeTruthy();
		expect(banner?.textContent).toContain("AuthenticationError: Insufficient Balance.");
		expect(banner?.textContent).toContain("Check the provider's credit or key, or switch model.");
	});

	it("an older galopin's empty reason keeps today's look", () => {
		const { baseElement } = mount([turnState("failed")]);
		expect(baseElement.querySelector('[data-testid="turn-failed-reason"]')).toBeNull();
	});
});
