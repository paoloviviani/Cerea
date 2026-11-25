import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	conversation: true,
	row: true,
	allowed: vi.fn(async () => true),
	callToolFromPage: vi.fn(),
}));

vi.mock("$lib/server/auth", () => ({ authCondition: () => ({}) }));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: {
			findOne: vi.fn(async () =>
				fake.conversation ? { _id: 1, approvedTools: [], toolApprovalOverride: undefined } : null
			),
		},
		codeExecutionOutputs: {
			findOne: vi.fn(async () => (fake.row ? { _id: 1, summary: "connector:1" } : null)),
		},
		settings: { findOne: vi.fn(async () => ({ toolApprovalPolicy: "manual" })) },
	},
}));
vi.mock("$lib/server/execution/deliverables", async () => {
	const { Readable } = await import("node:stream");
	return {
		openDeliverable: vi.fn(async () => ({
			stream: Readable.from([Buffer.from("<script>alert(1)</script>")]),
			size: 25,
			mime: "text/html",
			name: "mcp-app-x.html",
		})),
	};
});
vi.mock("$lib/server/mcp/appsPolicy", () => ({ appsAllowedFor: fake.allowed }));
vi.mock("$lib/server/mcp/apps/pageCall", () => ({ callToolFromPage: fake.callToolFromPage }));

const page = await import("./[sha256]/+server");
const call = await import("./call/+server");

const id = new ObjectId().toHexString();
const locals = { user: { _id: new ObjectId() }, sessionId: "s" };

const getPage = () =>
	page.GET({
		params: { id, sha256: "a".repeat(64) },
		locals,
	} as never) as Promise<Response>;

const postCall = (body: unknown) =>
	call.POST({
		params: { id },
		locals,
		request: new Request("http://x/call", { method: "POST", body: JSON.stringify(body) }),
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

	it("takes an approval only in the two forms the card sends", async () => {
		await expect(postCall({ connector: "c", tool: "t", approval: "always" })).rejects.toMatchObject(
			{ status: 400 }
		);
		fake.callToolFromPage.mockResolvedValue({ ok: true, result: { content: [] } });
		await postCall({ connector: "c", tool: "t", approval: "once" });
		expect(fake.callToolFromPage).toHaveBeenCalledWith(
			expect.objectContaining({ approval: "once" })
		);
	});

	it("refuses a conversation the caller does not own, and a malformed body", async () => {
		await expect(postCall({ nope: 1 })).rejects.toMatchObject({ status: 400 });
		fake.conversation = false;
		await expect(postCall({ connector: "c", tool: "t" })).rejects.toMatchObject({ status: 404 });
		expect(fake.callToolFromPage).not.toHaveBeenCalled();
	});
});
