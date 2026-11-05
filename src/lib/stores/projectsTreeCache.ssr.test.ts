import { describe, expect, it } from "vitest";
import { bindProjectsCacheOwner, projectsTreeCache } from "./projectsTreeCache.svelte";

/**
 * On the server this module is shared by every request, so binding an owner
 * there would write one user's id into state the next request reads.
 */
describe("projectsTreeCache on the server", () => {
	it("never binds an owner", () => {
		bindProjectsCacheOwner("ada");
		expect(projectsTreeCache.owner).toBeNull();
	});
});
