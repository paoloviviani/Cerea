import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { collections, ready } from "$lib/server/database";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/server/api/__tests__/testHelpers";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { sourceSha256 } from "$lib/server/office/previewStore";

const config = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<{ config: Record<string, unknown> }>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (target, key: string) => (key in config ? config[key] : target[key]),
		}),
	};
});

const { GET } = await import("./+server");

const PDF = Buffer.from("%PDF-1.7\nroute");
let server: http.Server;
let conversions = 0;
let status = 200;

beforeAll(async () => {
	await ready;
	server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			conversions += 1;
			res.writeHead(status, { "Content-Type": "application/pdf" });
			res.end(status === 200 ? PDF : "no");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
	conversions = 0;
	status = 200;
	config.CHAT_GOTENBERG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	delete config.CHAT_GOTENBERG_URL;
	await cleanupTestData();
});

async function produced(locals: ReturnType<typeof createTestLocals>, name: string, text: string) {
	const conv = await createTestConversation(locals);
	const bytes = Buffer.from(text);
	// Not an Office name at store time would skip the eager conversion; use a txt name
	// first so the preview below is the lazy path, then rename the row.
	const stored = await storeDeliverable({
		conversationId: conv._id,
		userId: locals.user?._id,
		name: "plain.txt",
		mime: "application/octet-stream",
		bytes,
	});
	if (!stored.ok) throw new Error("store failed");
	await collections.codeExecutionOutputs.updateOne(
		{ conversationId: conv._id },
		{ $set: { name } }
	);
	return { conv, sha: sourceSha256(bytes) };
}

describe.sequential("GET .../code-execution/output/[sha256]/preview", () => {
	it("converts on the first view, serves the stored PDF on the second", async () => {
		const { locals } = await createTestUser();
		const { conv, sha } = await produced(locals, "deck.pptx", `deck ${Math.random()}`);
		const call = () =>
			GET({
				params: { id: conv._id.toString(), sha256: sha },
				locals,
				request: new Request("http://x"),
			} as never);

		const first = await call();
		expect(first.status).toBe(200);
		expect(first.headers.get("Content-Type")).toBe("application/pdf");
		expect(first.headers.get("Content-Disposition")).toContain("attachment");
		expect(Buffer.from(await first.arrayBuffer()).equals(PDF)).toBe(true);
		const second = await call();
		expect(second.status).toBe(200);
		expect(conversions).toBe(1);
	});

	it("is 404 for a stranger's conversation, and 404 when the deployment has no converter", async () => {
		const { locals } = await createTestUser();
		const { conv, sha } = await produced(locals, "deck.pptx", `deck ${Math.random()}`);
		const { locals: stranger } = await createTestUser();
		await expect(
			GET({
				params: { id: conv._id.toString(), sha256: sha },
				locals: stranger,
				request: new Request("http://x"),
			} as never)
		).rejects.toMatchObject({ status: 404 });

		delete config.CHAT_GOTENBERG_URL;
		const off = await GET({
			params: { id: conv._id.toString(), sha256: sha },
			locals,
			request: new Request("http://x"),
		} as never);
		expect(off.status).toBe(404);
		expect(conversions).toBe(0);
	});

	it("is 415 for a file that is not an Office document, and reports a busy converter as 503", async () => {
		const { locals } = await createTestUser();
		const text = await produced(locals, "notes.txt", `text ${Math.random()}`);
		await expect(
			GET({
				params: { id: text.conv._id.toString(), sha256: text.sha },
				locals,
				request: new Request("http://x"),
			} as never)
		).rejects.toMatchObject({ status: 415 });

		const deck = await produced(locals, "deck.pptx", `busy ${Math.random()}`);
		status = 503;
		const res = await GET({
			params: { id: deck.conv._id.toString(), sha256: deck.sha },
			locals,
			request: new Request("http://x"),
		} as never);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { message: string }).message).toContain("busy");
	});
});
