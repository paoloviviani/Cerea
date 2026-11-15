import { describe, expect, it } from "vitest";
import { knowledgeUploadMime } from "./knowledgeUpload";

describe("knowledgeUploadMime: line-delimited JSON", () => {
	it.each(["rows.jsonl", "rows.ndjson"])("%s is accepted as text", async (name) => {
		expect(await knowledgeUploadMime(Buffer.from('{"a":1}\n{"a":2}\n'), name)).toBe("text/plain");
	});
});
