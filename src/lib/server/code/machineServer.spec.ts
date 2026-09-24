import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Behind the Pystino stack the chat is built with APP_BASE=/chat, and the
// upgrade reaches this handler below SvelteKit with the base still on the path.
vi.mock("$app/paths", () => ({ base: "/chat" }));
vi.mock("$lib/server/code/machineAuth", () => ({
	authenticateMachineRequest: vi.fn(async () => ({
		ok: false,
		status: 401,
		message: "no bearer",
	})),
}));
vi.mock("$lib/server/code/machines", () => ({ acceptMachineConnection: vi.fn() }));

const { registerMachineUpgrade } = await import("./machineServer");

function upgrade(url: string) {
	registerMachineUpgrade();
	const handler = (globalThis as Record<symbol, unknown>)[Symbol.for("cerea.machineUpgrade")] as (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer
	) => void;
	const socket = { write: vi.fn(), destroy: vi.fn() };
	handler({ url, headers: {} } as IncomingMessage, socket as unknown as Duplex, Buffer.alloc(0));
	return socket;
}

describe("the machine upgrade under a base path", () => {
	it("takes /chat/api/v2/code/machine to authentication", async () => {
		const socket = upgrade("/chat/api/v2/code/machine");
		await vi.waitFor(() => expect(socket.write).toHaveBeenCalled());
		expect(String(socket.write.mock.calls[0][0])).toMatch(/^HTTP\/1\.1 401/);
	});

	it("drops a path without the base", async () => {
		const socket = upgrade("/api/v2/code/machine");
		await vi.waitFor(() => expect(socket.destroy).toHaveBeenCalled());
		expect(socket.write).not.toHaveBeenCalled();
	});
});
