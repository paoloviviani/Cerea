import { describe, it, expect, vi, beforeEach } from "vitest";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("$lib/server/logger", () => ({ logger: { error } }));

import { handleServerError } from "./error";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-access-token.sig";
const SESSION = "sess-0123456789-secret";

function input(routeId: string | null = "/conversation/[id]") {
	const request = new Request("http://localhost/conversation/abc", {
		headers: { cookie: `hf-chat=${SESSION}`, authorization: `Bearer ${TOKEN}` },
	});
	return {
		error: new Error("boom"),
		status: 500,
		message: "Internal Error",
		event: {
			request,
			url: new URL(request.url),
			params: { id: "abc" },
			route: { id: routeId },
			locals: {
				token: TOKEN,
				sessionId: SESSION,
				isAdmin: false,
				user: { _id: "u1", username: "ada", email: "ada@example.com" },
			},
		},
	} as unknown as Parameters<typeof handleServerError>[0];
}

describe("handleServerError", () => {
	beforeEach(() => error.mockClear());

	it("logs the failure without tokens, session ids, emails or headers", async () => {
		const res = await handleServerError(input());
		expect(res.errorId).toBeTruthy();
		expect(error).toHaveBeenCalledTimes(1);
		const entry = error.mock.calls[0][0];
		const text = JSON.stringify(entry);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(SESSION);
		expect(text).not.toContain("ada@example.com");
		expect(text).not.toMatch(/authorization|cookie/i);
		expect(entry).toMatchObject({
			user: { id: "u1", username: "ada" },
			isAdmin: false,
			routeId: "/conversation/[id]",
			params: { id: "abc" },
			status: 500,
			errorId: res.errorId,
		});
		expect(entry.stack).toContain("boom");
	});

	it("does not log a 404", async () => {
		await handleServerError(input(null));
		expect(error).not.toHaveBeenCalled();
	});
});
