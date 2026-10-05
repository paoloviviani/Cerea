import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: { env: null as string | null, stored: null as string | null, granted: [] as string[] },
}));
const writeMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => ({ email: "admin@example.org", isAdmin: true })),
}));
vi.mock("$lib/server/webSearch/config", async () => {
	const { resolveWebSearch } = await import("$lib/server/webSearch/resolution");
	return {
		envWebSearchModel: () => state.env,
		storedWebSearchModel: async () => state.stored,
		writeWebSearchModel: async (model: string | null) => {
			writeMock(model);
			state.stored = model;
		},
		resolveWebSearchFor: async () => ({
			...resolveWebSearch({
				envModel: state.env,
				storedModel: state.env ? null : state.stored,
				granted: state.granted,
			}),
			granted: state.granted,
		}),
	};
});

import { GET, PUT } from "./+server";

const event = (body?: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/web-search", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.env = null;
	state.stored = null;
	state.granted = [];
});

describe("admin web search", () => {
	it("reports no backends offered, for the screen's no-backend message", async () => {
		const body = await (await GET(event())).json();
		expect(body).toMatchObject({ available_backends: [], backend: null, source: "policy" });
	});

	it("lists the offered backends and the stored choice", async () => {
		state.granted = ["exa", "linkup"];
		state.stored = "linkup";
		const body = await (await GET(event())).json();
		expect(body).toMatchObject({
			available_backends: ["exa", "linkup"],
			backend: "linkup",
			stored_backend: "linkup",
			source: "stored",
		});
	});

	it("saves a backend the gateway offers", async () => {
		state.granted = ["exa"];
		const res = await PUT(event({ backend: "exa" }));
		expect(res.status).toBe(200);
		expect(writeMock).toHaveBeenCalledWith("exa");
		expect((await res.json()).backend).toBe("exa");
	});

	it("clears the choice with null", async () => {
		state.granted = ["exa"];
		state.stored = "exa";
		const res = await PUT(event({ backend: null }));
		expect(res.status).toBe(200);
		expect(writeMock).toHaveBeenCalledWith(null);
	});

	it("refuses a backend the gateway does not offer", async () => {
		state.granted = ["exa"];
		await expect(PUT(event({ backend: "jina" }))).rejects.toMatchObject({ status: 400 });
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("refuses a change when the environment decides, and says so on read", async () => {
		state.env = "exa";
		state.granted = ["exa"];
		await expect(PUT(event({ backend: null }))).rejects.toMatchObject({ status: 409 });
		expect((await (await GET(event())).json()).source).toBe("env");
	});
});
