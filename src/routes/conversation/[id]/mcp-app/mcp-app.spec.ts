import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	publicOrigin: undefined as string | undefined,
	conversation: true,
	row: true,
	allowed: vi.fn(async () => true),
	callToolFromPage: vi.fn(),
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("$lib/server/config", () => ({
	config: {
		get PUBLIC_ORIGIN() {
			return fake.publicOrigin;
		},
	},
}));
vi.mock("$lib/server/auth", () => ({ authCondition: () => ({}) }));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: {
			findOne: vi.fn(async () =>
				fake.conversation ? { _id: 1, approvedTools: [], toolApprovalOverride: undefined } : null
			),
		},
		codeExecutionOutputs: { findOne: vi.fn(async () => (fake.row ? { _id: 1 } : null)) },
		settings: { findOne: vi.fn(async () => ({ toolApprovalPolicy: "manual" })) },
	},
}));
vi.mock("$lib/server/execution/deliverables", async () => {
	const { Readable } = await import("node:stream");
	return {
		MCP_APP_FILE_TOOL: "mcp_app",
		openAppPage: vi.fn(async () =>
			fake.row
				? {
						stream: Readable.from([Buffer.from("<script>alert(1)</script>")]),
						size: 25,
						connector: "connector:1",
					}
				: undefined
		),
	};
});
vi.mock("$lib/server/logger", () => ({ logger: fake.logger }));
vi.mock("$lib/server/mcp/appsPolicy", () => ({ appsAllowedFor: fake.allowed }));
vi.mock("$lib/server/mcp/apps/pageCall", () => ({ callToolFromPage: fake.callToolFromPage }));

const page = await import("./[sha256]/+server");
const call = await import("./call/+server");
const diag = await import("./diag/+server");

const id = new ObjectId().toHexString();
const locals = { user: { _id: new ObjectId() }, sessionId: "s" };

const getPage = () =>
	page.GET({
		params: { id, sha256: "a".repeat(64) },
		locals,
	} as never) as Promise<Response>;

const postCall = (
	body: unknown,
	headers: Record<string, string> = {
		"content-type": "application/json",
		origin: "http://x",
	}
) =>
	call.POST({
		params: { id },
		locals,
		url: new URL("http://x/conversation/c/mcp-app/call"),
		request: new Request("http://x/call", { method: "POST", body: JSON.stringify(body), headers }),
	} as never) as Promise<Response>;

beforeEach(() => {
	fake.conversation = true;
	fake.row = true;
	fake.allowed.mockReset();
	fake.allowed.mockResolvedValue(true);
	fake.callToolFromPage.mockReset();
});

describe("the stored page route (a reload, without the connector)", () => {
	it("serves the stored HTML as plain text, sandboxed, never as a document of this origin", async () => {
		const res = await getPage();

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<script>alert(1)</script>");
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("serves nothing once apps are blocked for the connector", async () => {
		fake.allowed.mockResolvedValue(false);

		await expect(getPage()).rejects.toMatchObject({ status: 403 });
		expect(fake.allowed).toHaveBeenCalledWith("connector:1", locals.user._id);
	});

	it("needs a stored page of this conversation, and takes the connector from its record", async () => {
		fake.row = false;
		await expect(getPage()).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a conversation the caller does not own", async () => {
		fake.conversation = false;
		await expect(getPage()).rejects.toMatchObject({ status: 404 });
	});
});

describe("the page tool-call route", () => {
	it("hands the call to the gate with the connector from the card and the arguments", async () => {
		fake.callToolFromPage.mockResolvedValue({ ok: true, result: { content: [] } });

		const res = await postCall({ connector: "connector:1", tool: "refresh", arguments: { a: 1 } });

		expect(res.status).toBe(200);
		expect(fake.callToolFromPage).toHaveBeenCalledWith(
			expect.objectContaining({
				connector: "connector:1",
				tool: "refresh",
				args: { a: 1 },
				approval: undefined,
				settings: { toolApprovalPolicy: "manual" },
			})
		);
	});

	it("answers 409 with what to ask when the call needs approval", async () => {
		fake.callToolFromPage.mockResolvedValue({
			ok: false,
			status: 409,
			code: "approval_required",
			message: "needs approval",
			approval: { tool: "Maps:refresh", server: "Maps", toolName: "refresh" },
		});

		const res = await postCall({ connector: "connector:1", tool: "refresh" });

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: false, code: "approval_required" });
	});

	it("refuses a connector this conversation holds no stored page of", async () => {
		fake.row = false;
		await expect(postCall({ connector: "connector:9", tool: "t" })).rejects.toMatchObject({
			status: 403,
		});
		expect(fake.callToolFromPage).not.toHaveBeenCalled();
	});

	it("takes an approval only as the id the 409 issued with a choice, never a bare word", async () => {
		await expect(postCall({ connector: "c", tool: "t", approval: "once" })).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			postCall({ connector: "c", tool: "t", approval: { id: "not-a-uuid", choice: "once" } })
		).rejects.toMatchObject({ status: 400 });
		fake.callToolFromPage.mockResolvedValue({ ok: true, result: { content: [] } });
		const approval = { id: "11111111-1111-4111-8111-111111111111", choice: "once" };
		await postCall({ connector: "c", tool: "t", approval });
		expect(fake.callToolFromPage).toHaveBeenCalledWith(expect.objectContaining({ approval }));
	});

	it("takes only a JSON body from this site's own origin", async () => {
		const body = { connector: "connector:1", tool: "t" };
		await expect(
			postCall(body, { "content-type": "text/plain", origin: "http://x" })
		).rejects.toMatchObject({ status: 415 });
		await expect(
			postCall(body, { "content-type": "application/json", origin: "https://evil.example" })
		).rejects.toMatchObject({ status: 403 });
		await expect(postCall(body, { "content-type": "application/json" })).rejects.toMatchObject({
			status: 403,
		});
		expect(fake.callToolFromPage).not.toHaveBeenCalled();
	});

	it('refuses an opaque origin ("null", what a sandboxed page sends)', async () => {
		await expect(
			postCall(
				{ connector: "connector:1", tool: "t" },
				{ "content-type": "application/json", origin: "null" }
			)
		).rejects.toMatchObject({ status: 403 });
		expect(fake.callToolFromPage).not.toHaveBeenCalled();
	});

	it("accepts the host of the configured public origin (behind a proxy the request URL differs)", async () => {
		fake.publicOrigin = "https://chat.example.com";
		try {
			fake.callToolFromPage.mockResolvedValue({ ok: true, result: { content: [] } });
			const res = await postCall(
				{ connector: "connector:1", tool: "t" },
				{ "content-type": "application/json", origin: "https://chat.example.com" }
			);
			expect(res.status).toBe(200);
			// Another host is still refused.
			await expect(
				postCall(
					{ connector: "connector:1", tool: "t" },
					{ "content-type": "application/json", origin: "https://other.example.com" }
				)
			).rejects.toMatchObject({ status: 403 });
		} finally {
			fake.publicOrigin = undefined;
		}
	});

	it("refuses a conversation the caller does not own, and a malformed body", async () => {
		await expect(postCall({ nope: 1 })).rejects.toMatchObject({ status: 400 });
		fake.conversation = false;
		await expect(postCall({ connector: "c", tool: "t" })).rejects.toMatchObject({ status: 404 });
		expect(fake.callToolFromPage).not.toHaveBeenCalled();
	});
});

const postDiag = (body: unknown) =>
	diag.POST({
		params: { id },
		locals: { user: { _id: new ObjectId() }, sessionId: "s2" },
		url: new URL("http://x/conversation/c/mcp-app/diag"),
		request: new Request("http://x/diag", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json", origin: "http://x" },
		}),
	} as never) as Promise<Response>;

describe("the page diagnostics route", () => {
	beforeEach(() => fake.logger.warn.mockClear());

	it("logs metadata only: kinds and sources reduced to scheme, host and path, never message text", async () => {
		const res = await postDiag({
			connector: "connector:1",
			uri: "ui://mock/page.html",
			errors: [
				{ kind: "csp", source: "https://cdn.example.com/x.js?secret=1#h", message: "do not log" },
				{ kind: "error" },
			],
		});

		expect(res.status).toBe(204);
		const [fields] = fake.logger.warn.mock.calls[0];
		expect(fields).toEqual({
			connector: "connector:1",
			uri: "ui://mock/page.html",
			count: 2,
			errors: [{ kind: "csp", source: "https://cdn.example.com/x.js" }, { kind: "error" }],
		});
		expect(JSON.stringify(fields)).not.toContain("secret");
		expect(JSON.stringify(fields)).not.toContain("do not log");
	});

	it("refuses a kind outside the list, and an address that is not ui://", async () => {
		await expect(
			postDiag({ connector: "connector:1", uri: "ui://a", errors: [{ kind: "log warning" }] })
		).rejects.toMatchObject({ status: 400 });
		await expect(
			postDiag({ connector: "connector:1", uri: "https://a", errors: [{ kind: "error" }] })
		).rejects.toMatchObject({ status: 400 });
	});

	it("refuses a connector and address the conversation holds no stored page of", async () => {
		fake.row = false;
		await expect(
			postDiag({ connector: "connector:9", uri: "ui://a", errors: [{ kind: "error" }] })
		).rejects.toMatchObject({ status: 403 });
		expect(fake.logger.warn).not.toHaveBeenCalled();
	});
});
