/** The transcription model's own admin route: admin only, validated, and independent of knowledge bases. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, writeMock, listMock } = vi.hoisted(() => ({
	state: {
		admin: true,
		stored: null as string | null,
		env: null as string | null,
		reachable: true,
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
// Knowledge bases are off here: nothing in this route may need them.
vi.mock("$lib/server/knowledgeEnabled", () => ({ knowledgeEnabled: () => false }));
vi.mock("$lib/server/transcription", () => ({
	resolveTranscription: (o: {
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
	envTranscriptionModel: () => state.env,
	storedTranscriptionModel: async () => state.stored,
	writeTranscriptionModel: writeMock,
	listTranscriptionModels: listMock,
	probeTranscriptionModels: async (t: string) => ({
		models: await listMock(t),
		reachable: state.reachable,
	}),
}));

import { GET, PUT } from "./+server";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const put = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/transcription", {
			method: "PUT",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PUT>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.admin = true;
	state.stored = null;
	state.env = null;
	state.reachable = true;
	listMock.mockResolvedValue(["whisper-large-v3", "voxtral-mini"]);
});

describe("GET /api/v2/admin/transcription", () => {
	it("reports what is used now, where it came from, and the choices", async () => {
		const body = await (await GET(get())).json();
		expect(body).toEqual({
			model: "whisper-large-v3",
			source: "first-available",
			stored_model: null,
			env_model: null,
			available_models: ["whisper-large-v3", "voxtral-mini"],
			account_available: true,
			account_reason: null,
		});
	});

	it("says whether the administrator's own account can use the model, and why not", async () => {
		state.stored = "voxtral-mini";
		listMock.mockResolvedValue(["whisper-large-v3"]);
		expect(await (await GET(get())).json()).toMatchObject({
			account_available: false,
			account_reason: "not_granted",
		});

		state.stored = null;
		listMock.mockResolvedValue([]);
		expect(await (await GET(get())).json()).toMatchObject({
			account_available: false,
			account_reason: "no_model",
		});

		state.reachable = false;
		expect(await (await GET(get())).json()).toMatchObject({
			account_available: false,
			account_reason: "gateway_unreachable",
		});
	});

	it("is for administrators", async () => {
		state.admin = false;
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
	});
});

describe("PUT /api/v2/admin/transcription", () => {
	it("saves a model the catalogue lists, with knowledge bases off", async () => {
		const res = await PUT(put({ model: " voxtral-mini " }));
		expect(res.status).toBe(200);
		expect(writeMock).toHaveBeenCalledWith("voxtral-mini");
	});

	it("clears the choice with null", async () => {
		await PUT(put({ model: null }));
		expect(writeMock).toHaveBeenCalledWith(null);
	});

	it("cannot be written by somebody who is not an administrator", async () => {
		state.admin = false;
		await expect(PUT(put({ model: "voxtral-mini" }))).rejects.toMatchObject({ status: 403 });
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("answers 400, not 500, for a body that is not a model name or null", async () => {
		for (const body of [
			{ model: 5 },
			{ model: { a: 1 } },
			{ model: ["x"] },
			{},
			"not json",
			"null",
		]) {
			await expect(PUT(put(body))).rejects.toMatchObject({ status: 400 });
		}
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("refuses a model that is not a transcription model in the catalogue", async () => {
		await expect(PUT(put({ model: "gpt-chat" }))).rejects.toMatchObject({ status: 400 });
		listMock.mockResolvedValue([]);
		await expect(PUT(put({ model: "whisper-large-v3" }))).rejects.toMatchObject({ status: 400 });
		expect(writeMock).not.toHaveBeenCalled();
	});
});
