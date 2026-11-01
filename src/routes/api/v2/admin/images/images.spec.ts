/** The image model's own admin route: admin only, validated against the catalogue's image models. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, writeMock, listMock } = vi.hoisted(() => ({
	state: {
		admin: true,
		stored: null as string | null,
		env: null as string | null,
		askFirst: false,
		reachable: true,
		configured: true,
	},
	writeMock: vi.fn(),
	listMock: vi.fn(),
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/imageGeneration", () => ({
	resolveImage: (o: {
		storedModel: string | null;
		envModel: string | null;
		candidates: string[];
	}) =>
		o.storedModel
			? { model: o.storedModel, source: "stored" }
			: o.envModel
				? { model: o.envModel, source: "env" }
				: o.candidates[0]
					? { model: o.candidates[0], source: "first-available" }
					: { model: null, source: "none" },
	envImageModel: () => state.env,
	storedImageModel: async () => state.stored,
	imageAskFirst: async () => state.askFirst,
	writeImageConfig: writeMock,
	listImageModels: listMock,
	probeImageModels: async (t: string) => ({
		models: await listMock(t),
		reachable: state.reachable,
		configured: state.configured,
	}),
}));

import { GET, PUT } from "./+server";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/images", {
			method: "PUT",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.admin = true;
	state.stored = null;
	state.env = null;
	state.askFirst = false;
	state.reachable = true;
	state.configured = true;
	listMock.mockResolvedValue(["flux-2-klein-4b", "z-image-turbo"]);
});

describe("GET /api/v2/admin/images", () => {
	it("reports what draws now, where it came from, the choices and the approval switch", async () => {
		expect(await (await GET(get())).json()).toEqual({
			model: "flux-2-klein-4b",
			source: "first-available",
			stored_model: null,
			env_model: null,
			available_models: ["flux-2-klein-4b", "z-image-turbo"],
			account_available: true,
			account_reason: null,
			ask_first: false,
		});
	});

	it("says whether the administrator's own account can use the model, and why not", async () => {
		state.stored = "z-image-turbo";
		listMock.mockResolvedValue(["flux-2-klein-4b"]);
		expect(await (await GET(get())).json()).toMatchObject({
			account_available: false,
			account_reason: "not_granted",
		});
		state.stored = null;
		listMock.mockResolvedValue([]);
		expect(await (await GET(get())).json()).toMatchObject({ account_reason: "no_model" });
		state.reachable = false;
		expect(await (await GET(get())).json()).toMatchObject({
			account_reason: "gateway_unreachable",
		});
		state.configured = false;
		expect(await (await GET(get())).json()).toMatchObject({ account_reason: "no_gateway" });
	});

	it("is for administrators", async () => {
		state.admin = false;
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
	});
});

describe("PUT /api/v2/admin/images", () => {
	it("saves a model the catalogue lists as an image model", async () => {
		expect((await PUT(put({ model: " z-image-turbo " }))).status).toBe(200);
		expect(writeMock).toHaveBeenCalledWith({ model: "z-image-turbo" });
	});

	it("clears the choice with null and saves the approval switch alone or with it", async () => {
		await PUT(put({ model: null }));
		expect(writeMock).toHaveBeenLastCalledWith({ model: null });
		await PUT(put({ ask_first: true }));
		expect(writeMock).toHaveBeenLastCalledWith({ askFirst: true });
		await PUT(put({ model: "flux-2-klein-4b", ask_first: false }));
		expect(writeMock).toHaveBeenLastCalledWith({ model: "flux-2-klein-4b", askFirst: false });
	});

	it("cannot be written by somebody who is not an administrator", async () => {
		state.admin = false;
		await expect(PUT(put({ model: "z-image-turbo" }))).rejects.toMatchObject({ status: 403 });
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("answers 400, not 500, for a body that is not valid", async () => {
		for (const body of [
			{ model: 5 },
			{ model: ["x"] },
			{ ask_first: "yes" },
			{},
			"not json",
			"null",
		]) {
			await expect(PUT(put(body))).rejects.toMatchObject({ status: 400 });
		}
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("refuses a model that is not an image model in the catalogue", async () => {
		await expect(PUT(put({ model: "gpt-chat" }))).rejects.toMatchObject({ status: 400 });
		listMock.mockResolvedValue([]);
		await expect(PUT(put({ model: "z-image-turbo" }))).rejects.toMatchObject({ status: 400 });
		expect(writeMock).not.toHaveBeenCalled();
	});
});
