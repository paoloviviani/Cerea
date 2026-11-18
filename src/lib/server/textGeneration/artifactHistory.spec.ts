import { describe, expect, it } from "vitest";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";
import { prepareMessagesWithFiles } from "./utils/prepareFiles";
import { MAX_TAIL_ARTIFACTS, tailBudgetChars } from "./artifactHistory";

const FILLER = "<p>FILLER_LINE_XYZ</p>\n".repeat(50);
const deck = (marker: string) => `<section><h1>${marker}</h1></section>\n${FILLER}`;

type Msg = EndpointMessage & { id: string };
let seq = 0;
const user = (id: string, content: string): Msg =>
	({ id, from: "user", content, createdAt: new Date(2026, 0, 1, 0, seq++) }) as Msg;
const assistant = (id: string, content: string, updates?: MessageUpdate[]): Msg =>
	({ id, from: "assistant", content, createdAt: new Date(2026, 0, 1, 0, seq++), updates }) as Msg;
const create = (id: string, ident: string, title: string, content: string, type = "slides") =>
	assistant(
		id,
		`Made it.\n\n<artifact identifier="${ident}" type="${type}" title="${title}">${content}</artifact>`
	);
const update = (id: string, ident: string, from: string, to: string) =>
	assistant(
		id,
		`<artifact identifier="${ident}" type="update"><old_str>${from}</old_str><new_str>${to}</new_str></artifact>`
	);

const imageProcessor = (async () => {
	throw new Error("no images");
}) as never;

const history = (): Msg[] => [
	user("u1", "make a deck"),
	create("a1", "deck", "Cerea deck", deck("ALPHA_V1")),
	user("u2", "change it"),
	update("a2", "deck", "ALPHA_V1", "BETA_V2"),
	user("u3", "again"),
	update("a3", "deck", "BETA_V2", "GAMMA_V3"),
	user("u4", "looks good?"),
];

const build = (messages: Msg[], extra: Record<string, unknown> = {}) =>
	prepareMessagesWithFiles(messages, imageProcessor, false, {
		replayToolHistory: true,
		artifactHistory: { mode: "tool" },
		contextLengthTokens: 200_000,
		...extra,
	});
const text = (out: unknown) => JSON.stringify(out);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("artifact-aware history", () => {
	it("replays operations as stubs without contents, and the current version once at the tail", async () => {
		const out = await build(history());
		const all = text(out);
		expect(count(all, "FILLER_LINE_XYZ")).toBe(50); // the tail's copy only
		expect(all).not.toContain("ALPHA_V1");
		expect(all).not.toContain("BETA_V2");
		const assistants = out.filter((m) => m.role === "assistant").map((m) => m.content);
		expect(assistants[0]).toContain('[artifact "Cerea deck" (slides) → v1: created]');
		expect(assistants[1]).toBe('[artifact "Cerea deck" (slides) → v2: updated, 1 edit]');
		expect(assistants[2]).toBe('[artifact "Cerea deck" (slides) → v3: updated, 1 edit]');
		const last = out.at(-1);
		expect(last?.role).toBe("user");
		expect(String(last?.content)).toMatch(/^looks good\?\n\n<current_artifacts>/);
		expect(String(last?.content)).toContain(
			'<artifact identifier="deck" title="Cerea deck" type="slides" version="3">'
		);
		expect(String(last?.content)).toContain("GAMMA_V3");
	});

	it("leaves the history as stored when artifacts are off", async () => {
		const out = await build(history(), { artifactHistory: undefined });
		expect(text(out)).toContain("ALPHA_V1");
		expect(text(out)).toContain("<old_str>BETA_V2</old_str>");
		expect(text(out)).not.toContain("current_artifacts");
	});

	it("stubs the artifact tool's calls too, keeping the arguments valid JSON", async () => {
		const call = (uuid: string, args: Record<string, unknown>): MessageUpdate[] => [
			{
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Call,
				uuid,
				call: { name: "artifact", parameters: { command: "rewrite", identifier: "deck" } },
				argumentsRaw: JSON.stringify(args),
			} as MessageUpdate,
			{
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Result,
				uuid,
				result: {
					status: "success",
					call: { name: "artifact" },
					outputs: [{ text: "rewrote deck → v2" }],
				},
			} as unknown as MessageUpdate,
		];
		const msgs = [
			user("u1", "deck"),
			create("a1", "deck", "Cerea deck", deck("ALPHA_V1")),
			user("u2", "again"),
			assistant(
				"a2",
				`<artifact identifier="deck" type="slides" title="Cerea deck">${deck("DELTA_V2")}</artifact>\n\nDone.`,
				call("call1", { command: "rewrite", identifier: "deck", content: deck("DELTA_V2") })
			),
			user("u3", "ok"),
		];
		const out = await build(msgs);
		const calls = out.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls : []));
		expect(calls).toHaveLength(1);
		const args = JSON.parse((calls[0] as { function: { arguments: string } }).function.arguments);
		expect(args).toEqual({ command: "rewrite", identifier: "deck" });
		expect(text(out).split("DELTA_V2").length - 1).toBe(1); // the tail
		expect(text(out)).toContain("→ v2: rewritten]");
	});

	it("is byte-identical across two builds, and unchanged when a version is added (cache stable)", async () => {
		const base = history();
		const first = await build(base);
		const second = await build(base);
		expect(text(first)).toBe(text(second));

		// The model answers, the user asks again, v4 is made: everything before the new
		// user turn is the same bytes as what the previous request ended with.
		const next: Msg[] = [
			...base,
			assistant("a4", "Yes, it does."),
			user("u5", "tweak"),
			update("a5", "deck", "GAMMA_V3", "OMEGA_V4"),
			user("u6", "thanks"),
		];
		const after = await build(next);
		// The previous request's last user message carried the tail; all before it repeats.
		const prefix = first.slice(0, -1);
		expect(text(after.slice(0, prefix.length))).toBe(text(prefix));
		// The previous last user turn is the same apart from its tail.
		const prev = String(first.at(-1)?.content);
		expect(String(after[prefix.length].content)).toBe(
			prev.slice(0, prev.indexOf("\n\n<current_artifacts>"))
		);
		expect(String(after.at(-1)?.content)).toContain("OMEGA_V4");
		expect(text(after)).not.toContain("GAMMA_V3");
	});

	it("keeps the content of a message out of the stub when it spans think blocks", async () => {
		const msgs = [
			user("u1", "x"),
			assistant(
				"a1",
				`<think>plan the deck</think>\n<artifact identifier="deck" type="slides" title="D">${deck("ALPHA_V1")}</artifact>`
			),
			user("u2", "y"),
		];
		const out = await build(msgs, { attachReasoning: true });
		const a = out.find((m) => m.role === "assistant") as {
			content: string;
			reasoning_content?: string;
		};
		expect(a.content).toBe('[artifact "D" (slides) → v1: created]');
		expect(a.reasoning_content).toBe("plan the deck");
	});

	it("shows at most three artifacts, most recent first, the rest by name and version", async () => {
		const msgs: Msg[] = [user("u0", "go")];
		for (let i = 1; i <= 5; i += 1) {
			msgs.push(create(`a${i}`, `doc-${i}`, `Doc ${i}`, `# Doc ${i}\n\nbody${i}`, "markdown"));
			msgs.push(user(`u${i}`, "next"));
		}
		const tail = String((await build(msgs)).at(-1)?.content);
		expect(MAX_TAIL_ARTIFACTS).toBe(3);
		expect(count(tail, "<artifact identifier=")).toBe(3);
		expect(tail.indexOf('identifier="doc-5"')).toBeLessThan(tail.indexOf('identifier="doc-4"'));
		expect(tail).toContain('- doc-2 "Doc 2" (markdown) v1');
		expect(tail).toContain('- doc-1 "Doc 1" (markdown) v1');
		expect(tail).toContain("artifact tool's read");
	});

	it("respects the size budget: an artifact that does not fit is listed, not shown", async () => {
		const big = "y".repeat(5_000);
		const msgs = [
			user("u1", "a"),
			create("a1", "small", "Small", "tiny", "markdown"),
			user("u2", "b"),
			create("a2", "big", "Big", big, "markdown"),
			user("u3", "c"),
		];
		// A 10k-token window gives the tail 4,500 characters.
		expect(tailBudgetChars(10_000)).toBe(4_500);
		const tail = String((await build(msgs, { contextLengthTokens: 10_000 })).at(-1)?.content);
		expect(tail).toContain('<artifact identifier="small"');
		expect(tail).not.toContain(big);
		expect(tail).toContain('- big "Big" (markdown) v1, 5000 characters');
	});

	it("never includes a deleted version", async () => {
		const msgs = [
			user("u1", "a"),
			create("a1", "doc", "Doc", "secret-v1", "markdown"),
			user("u2", "b"),
			assistant(
				"a2",
				'<artifact identifier="doc" type="markdown" title="Doc">secret-v2</artifact>'
			),
			user("u3", "c"),
		];
		const out = await build(msgs, {
			artifactHistory: { mode: "tool", pruned: new Set(["a2:0"]) },
		});
		expect(text(out)).not.toContain("secret-v2");
		expect(text(out)).not.toContain("secret-v1");
		// The latest version is the deleted one: nothing of the artifact is shown.
		expect(text(out)).not.toContain("current_artifacts");
		// A deleted earlier version stays out while the current one is shown.
		const out2 = await build(msgs, {
			artifactHistory: { mode: "tool", pruned: new Set(["a1:0"]) },
		});
		expect(text(out2)).toContain("secret-v2");
		expect(text(out2)).not.toContain("secret-v1");
	});

	it("gives a tags-mode model the same stubs and an edit-by-update tail without read", async () => {
		const out = await build(history(), { artifactHistory: { mode: "tags" } });
		const tail = String(out.at(-1)?.content);
		expect(tail).toContain("targeted update block");
		expect(tail).not.toContain("read");
		expect(text(out)).not.toContain("ALPHA_V1");
	});

	it("does not touch the stored messages", async () => {
		const msgs = history();
		const before = JSON.stringify(msgs);
		await build(msgs);
		expect(JSON.stringify(msgs)).toBe(before);
	});
});
