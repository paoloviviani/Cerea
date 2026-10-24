/**
 * Test stand-in for `MachineMcpTransport`: each `start()` is one `mcp.open`, i.e. one new
 * server process on the machine. Counts them, so a spec can say how many galopin would start.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Transport } from "@modelcontextprotocol/client";

type Message = Parameters<NonNullable<Transport["onmessage"]>>[0];

const SERVER = fileURLToPath(new URL("./silentProbeServer.mjs", import.meta.url));
export const SLOW_MODERN_SERVER = fileURLToPath(new URL("./slowModernServer.mjs", import.meta.url));

export const machine = {
	opens: 0,
	closed: 0,
	onConfigClosed: [] as Array<(() => void) | undefined>,
};

export function resetMachine() {
	machine.opens = 0;
	machine.closed = 0;
	machine.onConfigClosed = [];
}

export class ChildLocalTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: Transport["onmessage"];
	sessionId?: string;
	// Like the SDK's stdio transport: a probe that gets no answer then means "legacy".
	readonly stderr = null;
	readonly pid = null;
	private child?: ChildProcess;
	private ended = false;

	/** A different server script, and the environment it is started with. */
	constructor(
		private readonly script: string = SERVER,
		private readonly env: Record<string, string> = {}
	) {}

	async start() {
		machine.opens++;
		const child = spawn(process.execPath, [this.script], {
			stdio: ["pipe", "pipe", "ignore"],
			env: { ...process.env, ...this.env },
		});
		this.child = child;
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.trim()) this.onmessage?.(JSON.parse(line) as Message);
			}
		});
		child.on("exit", () => this.finish());
	}

	private finish() {
		if (this.ended) return;
		this.ended = true;
		machine.closed++;
		this.onclose?.();
	}

	async send(message: Message) {
		this.child?.stdin?.write(JSON.stringify(message) + "\n");
	}

	async close() {
		this.child?.kill();
		this.finish();
	}
}
