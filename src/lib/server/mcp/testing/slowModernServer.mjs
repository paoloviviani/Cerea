// A stdio MCP server of the 2026 era that is slow on its first start, like an `npx` cold
// start fetching its package. The first process (no SLOW_MARKER file yet) creates the marker
// and sleeps SLOW_MS before reading anything, so the client's era probe times out and it
// falls back to the 2025 handshake; later processes start at once. It answers `server/discover`
// (modern) and `initialize` (legacy), but only lists tools to a modern-era request: asked the
// legacy way it answers an empty array (EMPTY_MODE "array", the default), or a result with no
// `tools` field ("missing"), or lists the tools anyway ("none"). EMPTY_MODE "always" makes
// every listing empty, on any era. `boom` fails with an RPC error.
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const marker = process.env.SLOW_MARKER;
const slowMs = Number(process.env.SLOW_MS ?? 0);
const emptyMode = process.env.EMPTY_MODE ?? "array";

const send = (message) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const cold = slowMs > 0 && marker && !existsSync(marker);
if (cold) writeFileSync(marker, "started");
if (cold) await new Promise((resolve) => setTimeout(resolve, slowMs));

const tools = [
	{ name: "echo", inputSchema: { type: "object", properties: {} } },
	{ name: "boom", inputSchema: { type: "object", properties: {} } },
];
const isModernRequest = (message) => {
	const meta = message.params?._meta;
	return !!meta && Object.keys(meta).some((key) => key.includes("protocolVersion"));
};

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined) return;
	if (message.method === "server/discover") {
		send({
			id: message.id,
			result: {
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
				ttlMs: 0,
				cacheScope: "private",
			},
		});
	} else if (message.method === "initialize") {
		send({
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "slow-modern", version: "1" },
			},
		});
	} else if (message.method === "tools/list") {
		const lists = emptyMode !== "always" && (isModernRequest(message) || emptyMode === "none");
		send({
			id: message.id,
			result: {
				// What a 2026-era result must carry; a 2025 caller ignores it.
				resultType: "complete",
				ttlMs: 0,
				cacheScope: "private",
				...(lists ? { tools } : emptyMode === "missing" ? {} : { tools: [] }),
			},
		});
	} else if (message.method === "tools/call") {
		if (message.params.name === "boom") {
			send({ id: message.id, error: { code: -32000, message: "boom" } });
		} else {
			send({
				id: message.id,
				result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] },
			});
		}
	} else {
		send({ id: message.id, error: { code: -32601, message: "method not found" } });
	}
});
