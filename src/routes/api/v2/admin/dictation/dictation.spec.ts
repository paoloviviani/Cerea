import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, resolveMock } = vi.hoisted(() => ({
	state: { stored: "" as string, managerOn: "true", legacy: false, admin: true },
	resolveMock: vi.fn(),
}));
const setMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/transcription", () => ({
	legacyTranscriptionConfigured: () => state.legacy,
	resolveTranscriptionModel: resolveMock,
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (key: string, value: string) => {
				setMock(key, value);
				if (key === "CHAT_DICTATION") state.stored = value;
			},
		} as Record<string, unknown>,
		{
			get(target, key: string) {
				if (key === "set") return target[key];
				if (key === "ENABLE_CONFIG_MANAGER") return state.managerOn;
				if (key === "CHAT_DICTATION") return state.stored;
				return undefined;
			},
		}
	),
}));

import { GET, PATCH } from "./+server";

const get = () => ({ locals: { token: "t" } }) as unknown as Parameters<typeof GET>[0];
const patch = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/dictation", {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PATCH>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.stored = "";
	state.managerOn = "true";
	state.legacy = false;
	state.admin = true;
	resolveMock.mockResolvedValue({ model: null, source: "none" });
});

describe("admin dictation", () => {
	it("defaults to the browser when unset", async () => {
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({ mode: "browser", transcriptionModel: null, configurable: true });
	});

	it("defaults to the model where the deprecated direct pair is set", async () => {
		state.legacy = true;
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({ mode: "model", legacyTranscription: true });
	});

	it("reads the old words as the new ones, and an unknown value as the default", async () => {
		state.stored = "no";
		expect((await (await GET(get())).json()).mode).toBe("off");
		state.stored = "yes";
		expect((await (await GET(get())).json()).mode).toBe("browser");
		state.stored = "banana";
		expect((await (await GET(get())).json()).mode).toBe("browser");
	});

	it("reports the model the option would use, and where it came from", async () => {
		resolveMock.mockResolvedValue({ model: "whisper-large-v3-turbo", source: "stored" });
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({
			transcriptionModel: "whisper-large-v3-turbo",
			transcriptionSource: "stored",
		});
	});

	it.each(["browser", "model", "off"])("stores %s", async (mode) => {
		const body = await (await PATCH(patch({ mode }))).json();
		expect(setMock).toHaveBeenCalledWith("CHAT_DICTATION", mode);
		expect(body).toEqual({ mode });
	});

	it("refuses a value that is not one of the three", async () => {
		await expect(PATCH(patch({ mode: "maybe" }))).rejects.toMatchObject({ status: 400 });
		await expect(PATCH(patch({ mode: "yes" }))).rejects.toMatchObject({ status: 400 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses a write from somebody who is not an administrator", async () => {
		state.admin = false;
		await expect(PATCH(patch({ mode: "model" }))).rejects.toMatchObject({ status: 403 });
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("says so when configuration is environment-only", async () => {
		state.managerOn = "false";
		await expect(PATCH(patch({ mode: "model" }))).rejects.toMatchObject({ status: 409 });
		expect(setMock).not.toHaveBeenCalled();
	});
});
