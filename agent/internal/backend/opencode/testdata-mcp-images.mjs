// The image IT's own MCP server: one tool, `shots`, whose single result
// carries nine ~2 MiB image blocks, so the tool part opencode streams holds
// ~24 MiB of data: URLs in one SSE line. Hand-written JSON-RPC over stdio
// (see testdata-mcp-server.mjs for why no SDK).
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";

// A real, decodable ~2 MiB PNG of noise (opencode resizes or omits images it
// cannot decode, so random bytes would never reach the tool part).
function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}
function noisePng(side) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(side, 0);
	ihdr.writeUInt32BE(side, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const row = 1 + side * 4;
	const raw = Buffer.alloc(row * side);
	for (let y = 0; y < side; y++) randomBytes(side * 4).copy(raw, y * row + 1);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const respond = (id, result) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\r\n");

const handlers = {
	initialize: () => ({
		protocolVersion: "2024-11-05",
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: "it-mcp-images", version: "1.0.0" },
	}),
	"tools/list": () => ({
		tools: [
			{
				name: "shots",
				description: "Nine large screenshots",
				inputSchema: { type: "object", properties: {} },
			},
		],
	}),
	"tools/call": () => ({
		content: [
			{ type: "text", text: "nine screenshots" },
			...Array.from({ length: 9 }, () => ({
				type: "image",
				mimeType: "image/png",
				data: noisePng(720).toString("base64"),
			})),
		],
	}),
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
	if (!line.trim()) return;
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return;
	}
	const handler = handlers[req.method];
	if (!handler || req.id === undefined) return;
	respond(req.id, handler(req.params ?? {}));
});
