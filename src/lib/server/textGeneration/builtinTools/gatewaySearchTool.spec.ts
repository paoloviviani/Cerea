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
	it("withholds the tool when no search backend is granted and DuckDuckGo is disabled", () => {
		expect(
			createGatewaySearchBuiltins({
				token: "bearer-token",
				searchModelIds: [],
				duckDuckGoEnabled: false,
			})
		).toEqual([]);
	});

	it("offers the tool on the DuckDuckGo fallback when no search backend is granted", () => {
		const [tool] = createGatewaySearchBuiltins({
			searchModelIds: [],
		}) as BuiltinTool[];
		expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
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
		const [tool] = createGatewaySearchBuiltins({
			token: "bearer-token",
			searchModelIds: ["exa"],
			duckDuckGoEnabled: false,
		}) as BuiltinTool[];

		expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
			error: "Search failed: No search provider is configured.",
		});
	});

	it("leaves a non-404 gateway failure on the gateway path even with DuckDuckGo on", async () => {
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(new GatewayCallFailed(402, "Payment required."));
		const [tool] = builtins() as BuiltinTool[];

		expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
			error: "Search failed: Payment required.",
		});
		expect(gatewayPostMock).toHaveBeenCalledOnce();
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

describe("DuckDuckGo fallback", () => {
	const DDG_PAGE = `
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample%2Eorg%2Fddg&amp;rut=x">DDG Hit</a>
</h2>
<div class="result__extras">
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample%2Eorg%2Fddg">A free snippet.</a>
</div></div></div>`;

	const stubDuckDuckGo = (html: string, status = 200) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(html, { status }))
		);
	};

	it("falls back to DuckDuckGo when the gateway reports no provider", async () => {
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(
			new GatewayCallFailed(404, "No search provider is configured for your billing group.")
		);
		stubDuckDuckGo(DDG_PAGE);
		try {
			const allowedFetchUrls = new Set<string>();
			const [tool] = createGatewaySearchBuiltins({
				token: "bearer-token",
				searchModelIds: ["exa"],
				allowedFetchUrls,
			}) as BuiltinTool[];

			expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
				resultText:
					"1. DDG Hit\nhttps://example.org/ddg\nA free snippet.\n\n(1 results via duckduckgo)",
			});
			expect(allowedFetchUrls).toEqual(new Set(["https://example.org/ddg"]));
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("searches DuckDuckGo without any grant or credential", async () => {
		stubDuckDuckGo(DDG_PAGE);
		try {
			const [tool] = createGatewaySearchBuiltins({ searchModelIds: [] }) as BuiltinTool[];

			const outcome = await tool.execute({ query: "anything" }, CTX);
			expect(gatewayPostMock).not.toHaveBeenCalled();
			expect(outcome).toEqual({
				resultText:
					"1. DDG Hit\nhttps://example.org/ddg\nA free snippet.\n\n(1 results via duckduckgo)",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("says the web is unreachable when DuckDuckGo answers a bot challenge", async () => {
		stubDuckDuckGo(`<form id="challenge-form"><div class="anomaly-modal__mask"></div></form>`);
		try {
			const [tool] = createGatewaySearchBuiltins({ searchModelIds: [] }) as BuiltinTool[];

			expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
				resultText:
					"DuckDuckGo showed a bot challenge instead of results. " +
					"Say you could not search the web just now.",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reports a DuckDuckGo outage as a model-readable error", async () => {
		stubDuckDuckGo("nope", 503);
		try {
			const [tool] = createGatewaySearchBuiltins({ searchModelIds: [] }) as BuiltinTool[];

			expect(await tool.execute({ query: "anything" }, CTX)).toEqual({
				error: "Search failed: DuckDuckGo is unreachable right now.",
			});
		} finally {
			vi.unstubAllGlobals();
		}
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
