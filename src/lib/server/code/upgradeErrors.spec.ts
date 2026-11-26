/**
 * The three raw WebSocket upgrade handlers (machine link, terminal, desktop window) run below
 * SvelteKit on a socket nobody else is watching: a client that resets the connection while their
 * checks are awaited would raise an 'error' event with no listener and take the process down.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { base } from "$app/paths";
import { registerMachineUpgrade } from "$lib/server/code/machineServer";
import { WINDOW_PATH } from "$lib/server/browser/windowChannel";
import { MACHINE_PATH, TERMINAL_PATH } from "$lib/types/machineProtocol";

const MACHINE_UPGRADE_SYMBOL = Symbol.for("cerea.machineUpgrade");

function fakeSocket() {
	const socket = Object.assign(new EventEmitter(), {
		write: vi.fn(),
		destroy: vi.fn(),
	});
	return socket;
}

describe("the upgrade handlers", () => {
	registerMachineUpgrade();
	const dispatch = (globalThis as Record<symbol, unknown>)[MACHINE_UPGRADE_SYMBOL] as (
		req: IncomingMessage,
		socket: unknown,
		head: Buffer
	) => void;

	for (const [name, path] of [
		["machine link", MACHINE_PATH],
		["terminal", TERMINAL_PATH],
		["window browser", WINDOW_PATH],
	] as const) {
		it(`${name}: a socket error while the checks run is handled, not thrown`, async () => {
			const socket = fakeSocket();
			const req = { url: `${base}${path}`, headers: {} } as unknown as IncomingMessage;
			dispatch(req, socket, Buffer.alloc(0));
			expect(socket.listenerCount("error")).toBeGreaterThan(0);
			expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
			expect(socket.destroy).toHaveBeenCalled();
			await new Promise((r) => setTimeout(r, 20));
		});
	}
});
