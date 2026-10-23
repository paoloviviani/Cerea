// A stdio MCP server for latency tests: newline-delimited JSON-RPC. Before `initialize` it
// answers nothing at all (the shape of the real servers that ignore an unknown request), and
// after it answers tools/list and tools/call. `echo` returns its arguments; `ask` first sends
// the client an elicitation/create and returns what came back, like a legacy server prompting
// mid-call. SERVER_TAG is added to the echo so tests can tell processes apart.
import { createInterface } from "node:readline";

const tag = process.env.SERVER_TAG ?? "";
let initialized = false;
let nextId = 1000;
const waiting = new Map();

const send = (message) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === undefined && message.id !== undefined) {
		waiting.get(message.id)?.(message.result);
		waiting.delete(message.id);
		return;
	}
	if (message.method === "initialize") {
		initialized = true;
		send({
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "silent-probe", version: "1" },
			},
		});
		return;
	}
	if (!initialized) return; // the probe: ignored
	if (message.id === undefined) return;
	if (message.method === "tools/list") {
		send({
			id: message.id,
			result: {
				tools: ["echo", "ask"].map((name) => ({
					name,
					inputSchema: { type: "object", properties: {} },
				})),
			},
		});
	} else if (message.method === "tools/call") {
		const { name, arguments: args } = message.params;
		const finish = (extra) =>
			send({
				id: message.id,
				result: {
					content: [{ type: "text", text: `${tag}${JSON.stringify({ ...args, ...extra })}` }],
				},
			});
		if (name === "ask") {
			const id = nextId++;
			waiting.set(id, (answer) => finish({ answer: answer?.action ?? null }));
			setTimeout(
				() =>
					send({
						id,
						method: "elicitation/create",
						params: {
							message: "Which one?",
							requestedSchema: { type: "object", properties: { x: { type: "string" } } },
						},
					}),
				Number(args?.delayMs ?? 0)
			);
		} else {
			finish({});
		}
	} else {
		send({ id: message.id, error: { code: -32601, message: "method not found" } });
	}
});
