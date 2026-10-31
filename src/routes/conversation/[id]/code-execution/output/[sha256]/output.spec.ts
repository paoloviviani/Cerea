import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

const found = vi.hoisted(() => ({ conversation: true }));

vi.mock("$lib/server/auth", () => ({ authCondition: () => ({}) }));
vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: { findOne: vi.fn(async () => (found.conversation ? { _id: 1 } : null)) },
	},
}));
vi.mock("$lib/server/execution/deliverables", async () => {
	const { Readable } = await import("node:stream");
	return {
		openDeliverable: vi.fn(async () => ({
			stream: Readable.from([Buffer.from("<svg onload=alert(1)/>")]),
			size: 22,
			mime: "image/png",
			name: 'fig"ure-1.png',
		})),
	};
});

import { GET } from "./+server";

const call = () =>
	GET({
		params: { id: new ObjectId().toHexString(), sha256: "a".repeat(64) },
		locals: { user: { _id: 1 }, sessionId: "s" },
	} as never) as Promise<Response>;

/**
 * A deliverable is bytes a model wrote: the route serves it as a download,
 * sandboxed, and forbids the browser from second-guessing the type it names.
 */
describe("code-execution output route headers", () => {
	it("downloads, never renders: attachment, sandbox CSP, nosniff", async () => {
		const res = await call();
		expect(res.status).toBe(200);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
		expect(res.headers.get("content-disposition")).not.toContain('"fig"');
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-length")).toBe("22");
		expect(await res.text()).toBe("<svg onload=alert(1)/>");
	});

	it("refuses a conversation the caller does not own", async () => {
		found.conversation = false;
		try {
			await expect(call()).rejects.toMatchObject({ status: 404 });
		} finally {
			found.conversation = true;
		}
	});
});
