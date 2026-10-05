import { describe, expect, it, vi, beforeEach } from "vitest";

const gatewayPostMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock("$lib/server/gatewayServer", () => {
	class GatewayCallFailed extends Error {
		constructor(
			readonly status: number,
			message: string
		) {
			super(message);
			this.name = "GatewayCallFailed";
		}
	}
	return {
		GatewayCallFailed,
		gateway: { get: vi.fn(), post: gatewayPostMock, del: vi.fn() },
	};
});

vi.mock("$lib/server/config", () => ({
	config: { OPENAI_BASE_URL: "https://gateway.example/v1" },
}));

const { createGatewaySearchBuiltins, findSearchModelIds, WEB_SEARCH_TOOL_NAME } =
	await import("./gatewaySearchTool");
type BuiltinTool = import("./types").BuiltinTool;

const CTX = { uuid: "call-1" } as Parameters<BuiltinTool["execute"]>[1];

const searchAnswer = {
	results: [
		{ title: "First", url: "https://example.org/1", snippet: "One." },
		{ title: "Second", url: "https://example.org/2", snippet: "Two." },
	],
	backend: "exa",
};

const builtins = () =>
	createGatewaySearchBuiltins({
		token: "bearer-token",
		searchModelIds: ["exa"],
		allowedFetchUrls: new Set<string>(),
	});

beforeEach(() => {
	gatewayPostMock.mockReset();
	gatewayPostMock.mockResolvedValue(searchAnswer);
});

describe("createGatewaySearchBuiltins", () => {
	it("withholds the tool when no search backend is granted", () => {
		expect(createGatewaySearchBuiltins({ token: "bearer-token", searchModelIds: [] })).toEqual([]);
	});

	it("sends one unified shape to the unified route, never a vendor dialect", async () => {
		const [tool] = builtins() as BuiltinTool[];
		expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);

		const parameters = tool.definition.function.parameters as {
			properties: Record<string, unknown>;
		};
		// No backend enum, no depth: the group policy picks the backend and
		// the vendor always runs its default depth.
		expect(Object.keys(parameters.properties).sort()).toEqual(["max_results", "query"]);

		const outcome = await tool.execute({ query: "european cloud providers", max_results: 7 }, CTX);
		expect(gatewayPostMock).toHaveBeenCalledWith("bearer-token", "search", {
			query: "european cloud providers",
			max_results: 7,
		});
		expect(outcome).toEqual({
			resultText:
				"1. First\nhttps://example.org/1\nOne.\n\n" +
				"2. Second\nhttps://example.org/2\nTwo.\n\n" +
				"(2 results via exa)",
		});
	});

	it("names the administrator's chosen backend to the gateway, and only then", async () => {
		const [named] = createGatewaySearchBuiltins({
			token: "bearer-token",
			searchModelIds: ["exa", "linkup"],
			backend: "linkup",
		}) as BuiltinTool[];
		await named.execute({ query: "x" }, CTX);
		expect(gatewayPostMock).toHaveBeenLastCalledWith("bearer-token", "search", {
			query: "x",
			max_results: 5,
			backend: "linkup",
		});

		const [policy] = builtins() as BuiltinTool[];
		await policy.execute({ query: "x" }, CTX);
		expect(gatewayPostMock).toHaveBeenLastCalledWith("bearer-token", "search", {
			query: "x",
			max_results: 5,
		});
	});

	it("drops results without a usable URL and names untitled ones", async () => {
		gatewayPostMock.mockResolvedValue({
			results: [
				{ title: "Kept", url: "https://example.org/kept", snippet: "Yes." },
				{ title: "Nowhere", snippet: "No URL." },
				{ url: "https://example.org/untitled" },
			],
			backend: "linkup",
		});
		const [tool] = builtins() as BuiltinTool[];

		const outcome = await tool.execute({ query: "anything" }, CTX);
		expect(outcome).toEqual({
			resultText:
				"1. Kept\nhttps://example.org/kept\nYes.\n\n" +
				"2. untitled\nhttps://example.org/untitled\n\n" +
				"(2 results via linkup)",
		});
	});

	it("refuses an empty query and a missing credential without calling", async () => {
		const [tool] = builtins() as BuiltinTool[];
		expect(await tool.execute({ query: "   " }, CTX)).toEqual({
			error: "The search needs a query.",
		});
		expect(gatewayPostMock).not.toHaveBeenCalled();

		const [noToken] = createGatewaySearchBuiltins({
			searchModelIds: ["exa"],
		}) as BuiltinTool[];
		expect(await noToken.execute({ query: "anything" }, CTX)).toEqual({
			error: "No search credential for this session.",
		});
	});

	it("turns a gateway failure into a model-readable error", async () => {
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(
			new GatewayCallFailed(404, "No search provider is configured.")
		);
		const [tool] = builtins() as BuiltinTool[];

		expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
			error: "Search failed: No search provider is configured.",
		});
	});

	it("registers result URLs as later fetch targets", async () => {
		const allowedFetchUrls = new Set<string>();
		const [tool] = createGatewaySearchBuiltins({
			token: "bearer-token",
			searchModelIds: ["exa"],
			allowedFetchUrls,
		}) as BuiltinTool[];

		await tool.execute({ query: "anything" }, CTX);
		expect(allowedFetchUrls).toEqual(new Set(["https://example.org/1", "https://example.org/2"]));
	});
});

describe("findSearchModelIds", () => {
	it("keeps only kind search backends", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				data: [
					{ id: "exa", kind: "search" },
					{ id: "gpt-x", kind: "chat" },
					{ id: 42, kind: "search" },
				],
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await findSearchModelIds("bearer-token")).toEqual(["exa"]);
		vi.unstubAllGlobals();
	});

	it("yields none when the gateway cannot be asked", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("down");
			})
		);
		expect(await findSearchModelIds("bearer-token")).toEqual([]);
		vi.unstubAllGlobals();
	});
});
