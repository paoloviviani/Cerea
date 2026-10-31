import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Changing the document reader asks for no reason: the PUT accepts the change
 * without one, still takes one from an older client, and the history stores ""
 * when there is none.
 */

const { writeConfigMock, adminStatusMock, adminState } = vi.hoisted(() => ({
	writeConfigMock: vi.fn(),
	adminStatusMock: vi.fn(),
	adminState: { admin: true },
}));

vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!adminState.admin) throw Object.assign(new Error("forbidden"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/knowledgeEnabled", () => ({ knowledgeEnabled: () => true }));
vi.mock("$lib/server/knowledge/service", () => ({
	writeConfig: writeConfigMock,
	adminStatus: adminStatusMock,
}));

import { PUT } from "./+server";

function put(body: unknown) {
	return PUT({
		locals: { token: "t", user: { email: "admin@example.org" } },
		request: new Request("http://localhost/api/v2/admin/knowledge", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	} as unknown as Parameters<typeof PUT>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	adminState.admin = true;
	writeConfigMock.mockResolvedValue({ enabled: true, embeddingModel: null });
	adminStatusMock.mockResolvedValue({ extractor_model: "mistral-ocr-4.1" });
});

describe("PUT /api/v2/admin/knowledge", () => {
	it("accepts an extractor change with no reason", async () => {
		const res = await put({ extractor_model: "mistral-ocr-4.1" });

		expect(res.status).toBe(200);
		expect(writeConfigMock).toHaveBeenCalledWith(
			{ extractorModel: "mistral-ocr-4.1" },
			{ changedBy: "admin@example.org", reason: "" }
		);
	});

	it("still records a reason an older client sends", async () => {
		const res = await put({ extractor_model: "mistral-ocr-4.1", reason: "  EU provider  " });

		expect(res.status).toBe(200);
		expect(writeConfigMock.mock.calls[0][1]).toMatchObject({ reason: "EU provider" });
	});

	it("refuses a change from somebody who is not an administrator", async () => {
		adminState.admin = false;
		await expect(put({ extractor_model: "x" })).rejects.toMatchObject({ status: 403 });
		expect(writeConfigMock).not.toHaveBeenCalled();
	});
});
