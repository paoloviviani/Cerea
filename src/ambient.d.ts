declare module "*.ttf" {
	const value: ArrayBuffer;
	export default value;
}

/**
 * A minimal shape for the `ws` package's server-side API — `@types/ws` is not
 * vendored in this environment (node_modules is a shared, read-only symlink;
 * see CLAUDE.md), so this covers exactly what the machine link
 * (`$lib/server/code/machine*.ts`) actually calls.
 */
declare module "ws" {
	import type { IncomingMessage } from "node:http";
	import type { Socket } from "node:net";
	import type { EventEmitter } from "node:events";

	export class WebSocket extends EventEmitter {
		send(data: string | Buffer): void;
		close(code?: number, reason?: string): void;
		terminate(): void;
		ping(): void;
		on(event: "message", listener: (data: Buffer | string, isBinary: boolean) => void): this;
		on(event: "pong", listener: (data: Buffer) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "error", listener: (err: Error) => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
	}

	export class WebSocketServer extends EventEmitter {
		constructor(options: { noServer: true });
		handleUpgrade(
			request: IncomingMessage,
			socket: Socket,
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
