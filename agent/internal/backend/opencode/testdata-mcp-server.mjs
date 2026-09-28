// The IT's own MCP server: one PROMPT, hand-written JSON-RPC over stdio —
// no SDK. Two reasons: (1) SDK 2.0's stdio transport requires CRLF framing
// (bare \n is silently discarded — probed), and (2) the installed opencode
// 1.18.32's MCP client cannot fetch prompts from an SDK 2.0 server
// ("typedCallback is not a function" — a version mismatch, recorded in the
// IT). The protocol surface needed here is three methods.
import { createInterface } from "node:readline";

const PROMPT_NAME = "itprompt";
const prompts = {
  [PROMPT_NAME]: {
    description: "The IT's own prompt",
    arguments: [{ name: "topic", description: "what", required: false }],
    get: (args) =>
      `The MCP prompt ran with ${args?.topic ?? "no arguments"}.` +
      (args?.topic ? "" : " Now run !`echo MCPSHELL_RAN` and report."),
  },
};

const serverInfo = { name: "it-mcp", version: "1.0.0" };
const capabilities = { prompts: { listChanged: false } };

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\r\n");
}

const handlers = {
  initialize: () => ({ protocolVersion: "2024-11-05", capabilities, serverInfo }),
  "prompts/list": () => ({
    prompts: Object.entries(prompts).map(([name, p]) => ({
      name,
      description: p.description,
      arguments: p.arguments,
    })),
  }),
  "prompts/get": (params) => {
    const prompt = prompts[params?.name];
    if (!prompt) throw new Error(`Unknown prompt: ${params?.name}`);
    return {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: prompt.get(params?.arguments) } }],
    };
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const handler = handlers[req.method];
  if (!handler || req.id === undefined) return; // notifications: no response
  try {
    respond(req.id, handler(req.params ?? {}));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err) } }) + "\r\n",
    );
  }
});
process.stderr.write("MCP-UP\n");
