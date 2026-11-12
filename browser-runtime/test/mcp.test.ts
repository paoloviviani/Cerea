import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { actResultSchema, screenshotResultSchema, snapshotSchema } from "../src/contract.ts";
import { startFixtures, type Fixtures } from "./fixtures.ts";
import { TEST_KEY } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const text = (result: { content?: unknown }) =>
	(result.content as Array<{ type: string; text?: string }>)[0].text ?? "";

async function exercise(client: Client, fx: Fixtures) {
	const tools = await client.listTools();
	assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
		"act",
		"diff",
		"download",
		"end_task",
		"extract",
		"resume",
		"screenshot",
		"snapshot",
		"tabs",
	]);
	const nav = (await client.callTool({
		name: "act",
		arguments: { actions: [{ type: "navigate", url: `${fx.base}/form` }] },
	})) as never;
	const acted = actResultSchema.parse((nav as { structuredContent: unknown }).structuredContent);
	assert.equal(acted.results[0].ok, true);
	const snap = (await client.callTool({ name: "snapshot", arguments: {} })) as {
		structuredContent: unknown;
	};
	const parsed = snapshotSchema.parse(snap.structuredContent);
	assert.match(parsed.text, /button "Save" \(submits form\)/);
	// The same JSON is in the text block.
	assert.deepEqual(JSON.parse(text(snap as never)), snap.structuredContent);
	const shot = (await client.callTool({ name: "screenshot", arguments: {} })) as {
		content: Array<{ type: string; data: string; mimeType: string }>;
	};
	assert.equal(shot.content[0].type, "image");
	screenshotResultSchema.parse({ mime: shot.content[0].mimeType, base64: shot.content[0].data });
	assert.equal(shot.content[0].mimeType, "image/png");
	assert.equal(Buffer.from(shot.content[0].data, "base64").subarray(1, 4).toString(), "PNG");
	const saveRef = parsed.elements.find((e) => e.name === "Save")!.ref;
	const el = (await client.callTool({ name: "screenshot", arguments: { ref: saveRef } })) as {
		content: Array<{ data: string }>;
	};
	assert.ok(el.content[0].data.length > 100);
	// Malformed arguments are tool errors the model can read, not protocol errors.
	for (const [args, pattern] of [
		[{ actions: "not json" }, /needs "actions"/],
		[{ actions: [{ type: "clck", ref: "e1" }] }, /unknown type/],
		[{ actions: [{ type: "click" }] }, /ref/],
		[{}, /needs "actions"/],
	] as const) {
		const bad = (await client.callTool({ name: "act", arguments: args as never })) as {
			isError?: boolean;
		};
		assert.equal(bad.isError, true);
		assert.match(text(bad as never), pattern);
	}
	// Tolerated: a JSON string, a lone action, a number for text.
	const lenient = (await client.callTool({
		name: "act",
		arguments: {
			actions: JSON.stringify({
				type: "fill",
				ref: `[ref=${parsed.elements.find((e) => e.name === "Full name")!.ref}]`,
				text: 42,
			}),
		},
	})) as { structuredContent: unknown };
	assert.equal(
		actResultSchema.parse(lenient.structuredContent).results[0].outcome,
		"typed 2 characters"
	);
	const unknown = (await client.callTool({ name: "teleport", arguments: {} })) as {
		isError?: boolean;
	};
	assert.equal(unknown.isError, true);
}

describe("MCP over stdio", () => {
	let fx: Fixtures;
	let dir: string;
	before(async () => {
		fx = await startFixtures();
		dir = await mkdtemp(join(tmpdir(), "cerea-browser-mcp-"));
	});
	after(async () => {
		await fx.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("serves the six tools, as JSON and as an image", async () => {
		await writeFile(join(dir, "key"), TEST_KEY, { mode: 0o600 });
		const client = new Client({ name: "test", version: "0" });
		const args = [
			MAIN,
			"--profile",
			join(dir, "profile"),
			"--headless",
			"--key-file",
			join(dir, "key"),
		];
		if (process.env.CEREA_TEST_NO_SANDBOX === "1") args.push("--no-sandbox");
		await client.connect(
			new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" })
		);
		try {
			await exercise(client, fx);
		} finally {
			await client.close();
		}
	});
});

describe("MCP over Streamable HTTP", () => {
	let fx: Fixtures;
	let dir: string;
	before(async () => {
		fx = await startFixtures();
		dir = await mkdtemp(join(tmpdir(), "cerea-browser-mcp-"));
	});
	after(async () => {
		await fx.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("needs the bearer token, refuses browsers, and serves the tools", async () => {
		const { BrowserSession } = await import("../src/session.ts");
		const { serveHttp } = await import("../src/server.ts");
		const session = new BrowserSession({
			profileDir: join(dir, "profile"),
			headless: true,
			noSandbox: process.env.CEREA_TEST_NO_SANDBOX === "1",
		});
		const server = await serveHttp(session, { port: 0, host: "127.0.0.1", token: "s3cret" });
		const port = (server.address() as { port: number }).port;
		const url = new URL(`http://127.0.0.1:${port}/mcp`);
		try {
			const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			const headers = {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			};
			assert.equal((await fetch(url, { method: "POST", headers, body })).status, 401);
			assert.equal(
				(
					await fetch(url, {
						method: "POST",
						headers: { ...headers, authorization: "Bearer wrong" },
						body,
					})
				).status,
				401
			);
			assert.equal(
				(
					await fetch(url, {
						method: "POST",
						headers: { ...headers, authorization: "Bearer s3cret", origin: "http://evil.example" },
						body,
					})
				).status,
				403
			);
			assert.equal(
				(await fetch(url, { method: "GET", headers: { authorization: "Bearer s3cret" } })).status,
				405
			);
			assert.equal(
				(
					await fetch(new URL("/other", url), {
						method: "POST",
						headers: { authorization: "Bearer s3cret" },
						body,
					})
				).status,
				404
			);
			const client = new Client({ name: "test", version: "0" });
			await client.connect(
				new StreamableHTTPClientTransport(url, {
					requestInit: { headers: { authorization: "Bearer s3cret" } },
				})
			);
			try {
				await exercise(client, fx);
			} finally {
				await client.close();
			}
		} finally {
			server.close();
			await session.close();
		}
	});
});
