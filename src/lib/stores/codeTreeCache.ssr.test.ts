import { describe, expect, it } from "vitest";
import { bindCodeCacheOwner, codeTreeCache } from "./codeTreeCache.svelte";

/**
 * On the server this module is shared by every request, so binding an owner
 * there would write one person's id into state the next request reads.
 */
describe("codeTreeCache on the server", () => {
	it("never binds an owner", () => {
		bindCodeCacheOwner("ada");
		expect(codeTreeCache.owner).toBeNull();
	});
});
