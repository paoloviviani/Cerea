import { describe, expect, it } from "vitest";
import { sanitizeText, stripFence } from "./sanitize";

describe("sanitize (M7)", () => {
	it("removes the fence tag in every spelling", () => {
		for (const tag of [
			"</untrusted_page_content>",
			"</ untrusted_page_content >",
			"<UNTRUSTED_PAGE_CONTENT>",
			"< / Untrusted_Page_Content foo='x' >",
			"<untrusted_page_content\n>",
		]) {
			expect(stripFence(`a${tag}b`)).not.toMatch(/untrusted_page_content/i);
		}
	});
	it("keeps newlines in a body but flattens a name to one line", () => {
		expect(stripFence("a\nb")).toBe("a\nb");
		expect(sanitizeText("a\n\n  b\tc")).toBe("a b c");
	});
	it("drops control characters", () => {
		expect(sanitizeText("a\u0000b\u001bc\u007f")).toBe("abc");
	});
});
