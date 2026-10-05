/**
 * The mounted-files row: a chat attachment that could not be put in the
 * sandbox is listed as "not available" with the reason, next to the files that
 * were.
 */
import { afterEach, describe, expect, it } from "vitest";
import { page } from "@vitest/browser/context";

import MountedChips from "./MountedChips.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { getMountsStore } from "$lib/utils/execution/mounts.svelte";

afterEach(() => {
	getMountsStore()?.dropConversationFiles();
	document.body.innerHTML = "";
});

describe("MountedChips", () => {
	it("lists a file that failed to mount as not available, with the reason", async () => {
		const mounts = getMountsStore();
		mounts?.recordConversationFile({ path: "/mnt/data/ok.csv", name: "ok.csv" });
		mounts?.recordSkipped({ name: "gone.pdf", reason: "the request failed (404)" });
		renderWithApp(MountedChips, {});

		await expect
			.poll(() => page.getByText("gone.pdf not available: the request failed (404)").elements())
			.toHaveLength(1);
		expect(page.getByText("/mnt/data/ok.csv").elements()).toHaveLength(1);
	});
});
