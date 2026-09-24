import { describe, expect, it } from "vitest";
import { decodePartialJsonString, extractArtifactDraft } from "./artifactDraft";

const args = (content: string) =>
	JSON.stringify({
		command: "create",
		identifier: "snake-game",
		type: "html",
		title: "Snake Game",
		content,
	});

describe("decodePartialJsonString", () => {
	it("decodes escapes", () => {
		expect(decodePartialJsonString('a\\"b\\\\c\\nd\\u00e9')).toBe('a"b\\c\nd\xe9');
	});

	it("drops a chunk cut mid-escape", () => {
		expect(decodePartialJsonString("hello\\")).toBe("hello");
	});

	it("drops a chunk cut mid-\\u sequence", () => {
		expect(decodePartialJsonString("caf\\u00")).toBe("caf");
		expect(decodePartialJsonString("caf\\u00e")).toBe("caf");
		expect(decodePartialJsonString("caf\\u00e9 and more")).toBe("caf\xe9 and more");
	});

	it("leaves plain text alone", () => {
		expect(decodePartialJsonString("<h1>hi</h1>")).toBe("<h1>hi</h1>");
	});
});

describe("extractArtifactDraft", () => {
	it("returns null before anything identifying arrives", () => {
		expect(extractArtifactDraft("")).toBeNull();
		expect(extractArtifactDraft("{")).toBeNull();
		expect(extractArtifactDraft('{"comm')).toBeNull();
	});

	it("extracts partial content from a truncated call", () => {
		const full = args("<h1>Hello</h1><p>World</p>");
		for (const cut of [40, 80, 100, full.length - 10]) {
			const draft = extractArtifactDraft(full.slice(0, cut));
			expect(draft, `cut at ${cut}`).not.toBeNull();
			expect(draft?.command).toBe("create");
			expect(draft?.contentComplete).toBe(false);
		}
		const done = extractArtifactDraft(full);
		expect(done?.content).toBe("<h1>Hello</h1><p>World</p>");
		expect(done?.contentComplete).toBe(true);
		expect(done?.identifier).toBe("snake-game");
		expect(done?.artifactType).toBe("html");
		expect(done?.title).toBe("Snake Game");
	});

	it("grows monotonically as chunks arrive", () => {
		const full = args("abcdefghijklmnopqrstuvwxyz");
		let prev = "";
		for (let cut = 30; cut < full.length; cut += 7) {
			const draft = extractArtifactDraft(full.slice(0, cut));
			const content = draft?.content ?? "";
			expect(content.startsWith(prev)).toBe(true);
			prev = content;
		}
	});

	it("handles an update call with no content", () => {
		const draft = extractArtifactDraft(
			JSON.stringify({ command: "update", identifier: "doc", old_str: "a", new_str: "b" })
		);
		expect(draft?.command).toBe("update");
		expect(draft?.identifier).toBe("doc");
		expect(draft?.content).toBe("");
	});

	it("recovers content after a cut mid-escape", () => {
		const full = args('say "hi"\nbye');
		// Find a chunk boundary inside an escape of the encoded form.
		const encoded = full;
		const escIdx = encoded.indexOf("\\n");
		const draft = extractArtifactDraft(encoded.slice(0, escIdx + 1));
		expect(draft).not.toBeNull();
		const whole = extractArtifactDraft(encoded);
		expect(whole?.content).toBe('say "hi"\nbye');
	});
});
