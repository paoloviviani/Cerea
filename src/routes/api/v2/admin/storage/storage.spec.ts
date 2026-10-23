import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: { stored: "" as string, managerOn: "true", lastSummaryDays: -1 },
}));
const setMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => ({ email: "admin@example.org", isAdmin: true })),
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{
			set: async (key: string, value: string) => {
				setMock(key, value);
				if (key === "CHAT_FILE_RETENTION_DAYS") state.stored = value;
			},
		} as Record<string, unknown>,
		{
			get(target, key: string) {
				if (key === "set") return target.set;
				if (key === "ENABLE_CONFIG_MANAGER") return state.managerOn;
				if (key === "CHAT_FILE_RETENTION_DAYS") return state.stored;
				return undefined;
			},
		}
	),
}));
// The real deliverables module is imported below only for its constants and
// parser. It reaches for the database at import, and with `config` mocked here
// (no MONGODB_URL) that would start its own in-memory MongoDB, outside the
// suite's shared test database. Nothing in this spec touches a collection.
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/execution/deliverables", async () => {
	const actual = await vi.importActual<typeof import("$lib/server/execution/deliverables")>(
		"$lib/server/execution/deliverables"
	);
	return {
		DEFAULT_RETENTION_DAYS: actual.DEFAULT_RETENTION_DAYS,
		MAX_RETENTION_DAYS: actual.MAX_RETENTION_DAYS,
		fileRetentionDays: () => actual.parseRetentionDays(state.stored),
		deliverableStorageSummary: async (days: number) => {
			state.lastSummaryDays = days;
			return { files: 3, bytes: 3000, expiring: { files: days === 0 ? 0 : 1, bytes: 1000 } };
		},
	};
});

import { GET, PATCH } from "./+server";

const get = (query = "") =>
	({
		locals: { token: "t" },
		url: new URL(`http://localhost/api/v2/admin/storage${query}`),
	}) as unknown as Parameters<typeof GET>[0];
const patch = (body: unknown) =>
	({
		locals: { token: "t" },
		request: new Request("http://localhost/api/v2/admin/storage", {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	}) as unknown as Parameters<typeof PATCH>[0];

beforeEach(() => {
	vi.clearAllMocks();
	state.stored = "";
	state.managerOn = "true";
	state.lastSummaryDays = -1;
});

describe("admin storage", () => {
	it("reports the default 30 days, the store's size and what it would expire", async () => {
		const body = await (await GET(get())).json();
		expect(body).toMatchObject({
			retentionDays: 30,
			defaultDays: 30,
			configurable: true,
			files: 3,
			bytes: 3000,
			expiring: { files: 1 },
		});
		expect(state.lastSummaryDays).toBe(30);
	});

	it("previews another period without saving it", async () => {
		await GET(get("?days=7"));
		expect(state.lastSummaryDays).toBe(7);
		expect(setMock).not.toHaveBeenCalled();
	});

	it("refuses a preview that is not a whole number of days", async () => {
		await expect(GET(get("?days=-1"))).rejects.toMatchObject({ status: 400 });
	});

	it("saves a period, and 0 for never", async () => {
		expect((await (await PATCH(patch({ retentionDays: 90 }))).json()).retentionDays).toBe(90);
		expect(setMock).toHaveBeenCalledWith("CHAT_FILE_RETENTION_DAYS", "90");
		expect((await (await PATCH(patch({ retentionDays: 0 }))).json()).retentionDays).toBe(0);
	});

	it("refuses a value out of range or not a number", async () => {
		await expect(PATCH(patch({ retentionDays: 99999 }))).rejects.toMatchObject({ status: 400 });
		await expect(PATCH(patch({ retentionDays: "soon" }))).rejects.toMatchObject({ status: 400 });
		expect(setMock).not.toHaveBeenCalled();
	});

	it("says so when configuration lives in the environment only", async () => {
		state.managerOn = "false";
		await expect(PATCH(patch({ retentionDays: 10 }))).rejects.toMatchObject({ status: 409 });
		expect(setMock).not.toHaveBeenCalled();
	});
});
