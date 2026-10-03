declare module "*.ttf" {
	const value: ArrayBuffer;
	export default value;
}

/**
 * A minimal shape for the `ws` package's server-side API — `@types/ws` is not
 * vendored in this environment (node_modules is a shared, read-only symlink;
 * see AGENTS.md), so this covers exactly what the machine link
 * (`$lib/server/code/machine*.ts`) actually calls.
 */
declare module "ws" {
	import type { IncomingMessage } from "node:http";
	import type { Duplex } from "node:stream";
	import type { EventEmitter } from "node:events";

	export class WebSocket extends EventEmitter {
		constructor(address: string, options?: { headers?: Record<string, string> });
		readonly readyState: number;
		readonly CONNECTING: number;
		readonly OPEN: number;
		readonly CLOSING: number;
		readonly CLOSED: number;
		binaryType: string;
		send(data: string | Buffer): void;
		close(code?: number, reason?: string): void;
		terminate(): void;
		ping(): void;
		on(event: "open", listener: () => void): this;
		on(event: "message", listener: (data: Buffer | string, isBinary: boolean) => void): this;
		on(event: "pong", listener: (data: Buffer) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "error", listener: (err: Error) => void): this;
		// `res` is Node's own `http.IncomingMessage` on this event, but only
		// `statusCode` is used anywhere this shim's callers read it from.
		on(
			event: "unexpected-response",
			listener: (req: unknown, res: { statusCode?: number }) => void
		): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
		off(event: "message", listener: (data: Buffer | string, isBinary: boolean) => void): this;
		off(event: string, listener: (...args: unknown[]) => void): this;
	}

	export class WebSocketServer extends EventEmitter {
		constructor(options: { noServer: true; maxPayload?: number });
		close(callback?: (err?: Error) => void): void;
		handleUpgrade(
			request: IncomingMessage,
			// Node's own `http.Server` "upgrade" event types this `Duplex`, not
			// the narrower `net.Socket` — matching it here is what lets a real
			// upgrade handler's socket pass straight through untyped.
			socket: Duplex,
			head: Buffer,
			callback: (client: WebSocket, request: IncomingMessage) => void
		): void;
	}
}

// Legacy helpers removed: web search support is deprecated, so we intentionally
// avoid leaking those shapes into the global ambient types.

/**
 * Build flag for ML Assistant mode, inlined by Vite's `define` (see vite.config.ts).
 * Set `ML_ASSISTANT_MODE=true` in the build environment to compile the feature in;
 * with it off the constant folds to `false` and every gate on it is dead code.
 */
declare const __ML_ASSISTANT_MODE__: boolean;
