import { beforeEach, describe, expect, it, vi } from "vitest";

const findMock = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/config", () => ({ config: {} }));
vi.mock("$lib/server/textGeneration/builtinTools/gatewaySearchTool", () => ({
	findSearchModelIds: findMock,
}));

const { cachedSearchModelIds, clearSearchModelCache } = await import("./config");

beforeEach(() => {
	findMock.mockReset();
	findMock.mockResolvedValue(["exa"]);
	clearSearchModelCache();
});

describe("cachedSearchModelIds", () => {
	it("asks the gateway once per caller within the window", async () => {
		expect(await cachedSearchModelIds("a", 1_000)).toEqual(["exa"]);
		await cachedSearchModelIds("a", 20_000);
		expect(findMock).toHaveBeenCalledTimes(1);
	});

	it("keeps callers apart and asks again after the window", async () => {
		await cachedSearchModelIds("a", 1_000);
		await cachedSearchModelIds("b", 1_000);
		await cachedSearchModelIds("a", 40_000);
		expect(findMock).toHaveBeenCalledTimes(3);
	});
});
