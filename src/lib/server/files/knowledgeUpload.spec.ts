import { describe, expect, it } from "vitest";
import { knowledgeUploadMime } from "./knowledgeUpload";

describe("knowledgeUploadMime: line-delimited JSON", () => {
	it.each(["rows.jsonl", "rows.ndjson"])("%s is accepted as text", async (name) => {
		expect(await knowledgeUploadMime(Buffer.from('{"a":1}\n{"a":2}\n'), name)).toBe("text/plain");
	});
});

describe("knowledgeUploadMime: text of any extension", () => {
	it("takes .drawio, .excalidraw and unknown extensions by their content", async () => {
		expect(
			await knowledgeUploadMime(Buffer.from('<?xml version="1.0"?><mxfile/>'), "d.drawio")
		).toBe("application/xml");
		expect(await knowledgeUploadMime(Buffer.from('{"type":"excalidraw"}'), "s.excalidraw")).toBe(
			"application/json"
		);
		expect(await knowledgeUploadMime(Buffer.from("words"), "n.foo")).toBe("text/plain");
		expect(await knowledgeUploadMime(Buffer.from([1, 0, 2, 255]), "n.bin")).toBeNull();
	});
});
