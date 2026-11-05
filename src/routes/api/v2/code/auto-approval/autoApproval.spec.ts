/** What the composer reads (ADR 0107): in the code API's superjson shape, with no instructions or model name. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import superjson from "superjson";

vi.mock("$lib/server/codeDevices", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/codeDevices")>()),
	requireCodeAgents: vi.fn(async () => {}),
}));

import { collections, ready } from "$lib/server/database";
import { saveAgentReviewSettings } from "$lib/server/agentReview";
import { GET } from "./+server";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.agentReviewConfig.deleteMany({});
});

const read = async () =>
	superjson.parse<{ available: boolean; perClass: Record<string, string> }>(
		await (await GET({ locals: {} } as never)).text()
	);

describe("GET /api/v2/code/auto-approval", () => {
	it("says no reviewer until one is set up, then yes with the rows", async () => {
		expect((await read()).available).toBe(false);
		await saveAgentReviewSettings({ enabled: true, decisionModelId: "judge" });
		const now = await read();
		expect(now.available).toBe(true);
		expect(now.perClass).toMatchObject({ command: "reviewer", secrets: "you", loop: "you" });
	});

	it("never carries the instructions or the model", async () => {
		await saveAgentReviewSettings({
			enabled: true,
			decisionModelId: "judge",
			instructions: "secret policy",
		});
		const text = await (await GET({ locals: {} } as never)).text();
		expect(text).not.toContain("secret policy");
		expect(text).not.toContain("judge");
	});
});
