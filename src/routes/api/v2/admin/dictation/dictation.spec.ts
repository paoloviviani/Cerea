import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: { stored: "" as string, managerOn: "true", transcription: "", admin: true },
}));
const setMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!state.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (key: string, value: string) => {
				setMock(key, value);
				if (key === "CHAT_DICTATION") state.stored = value;
			},
			get: (key: string) =>
				key === "TRANSCRIPTION_MODEL"
					? state.transcription
					: key === "TRANSCRIPTION_BASE_URL"
						? "https://stt.example.org/models"
						: "",
		} as Record<string, unknown>,
		{
			get(target, key: string) {
				if (key === "set" || key === "get") return target[key];
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
	state.transcription = "";
	state.admin = true;
});

describe("admin dictation", () => {
	it("defaults to 'only when no voice model is available' when unset", async () => {
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({
			mode: "fallback",
			transcriptionEnabled: false,
			configurable: true,
		});
	});

	it("reads an unknown stored value as the default", async () => {
		state.stored = "banana";
		expect((await (await GET(get())).json()).mode).toBe("fallback");
	});

	it("reports whether a voice model exists", async () => {
		state.transcription = "whisper";
		expect((await (await GET(get())).json()).transcriptionEnabled).toBe(true);
	});

	it.each(["yes", "no", "fallback"])("stores %s", async (mode) => {
		const body = await (await PATCH(patch({ mode }))).json();
		expect(setMock).toHaveBeenCalledWith("CHAT_DICTATION", mode);
		expect(body).toEqual({ mode });
	});

	it("refuses a value that is not one of the three", async () => {
		await expect(PATCH(patch({ mode: "maybe" }))).rejects.toMatchObject({ status: 400 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses a write from somebody who is not an administrator", async () => {
		state.admin = false;
		await expect(PATCH(patch({ mode: "yes" }))).rejects.toMatchObject({ status: 403 });
		await expect(GET(get())).rejects.toMatchObject({ status: 403 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("says so when configuration is environment-only", async () => {
		state.managerOn = "false";
		await expect(PATCH(patch({ mode: "yes" }))).rejects.toMatchObject({ status: 409 });
		expect(setMock).not.toHaveBeenCalled();
	});
});
