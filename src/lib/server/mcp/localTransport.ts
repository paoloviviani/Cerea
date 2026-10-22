/**
 * An MCP SDK `Transport` over one channel of the machine link (PROTOCOL.md §10).
 *
 * `start()` opens the channel (`mcp.open`), `send()` writes an `mcp` frame, incoming `mcp`
 * frames are handed to `onmessage`, and a `closed` frame (or the link dropping, which the
 * registry reports the same way) calls `onclose`, which makes the SDK fail whatever is pending
 * on the connection: a dead machine never leaves a call waiting. `close()` sends `mcp.close`.
 *
 * Everything above this is the ordinary client: the pool, tool listing, approval cards,
 * elicitation and sub-agents see a connection like any other.
 */

import type { Transport } from "@modelcontextprotocol/client";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	MachineLink,
	registerMcpChannel,
	sendMcpMessage,
	type McpChannelEvent,
} from "$lib/server/code/machines";
import { OpError } from "$lib/types/machineProtocol";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { parseLocalServerUrl } from "./localUrl";

type Message = Parameters<NonNullable<Transport["onmessage"]>>[0];

/** A JSON-RPC 2.0 object, enough to refuse a malformed frame before it reaches the SDK. */
function isJsonRpc(value: unknown): value is Message {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return message.jsonrpc === "2.0" && ("method" in message || "id" in message);
}

export class MachineMcpTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: Transport["onmessage"];
	sessionId?: string;

	private channelId: string | null = null;
	private unregister: (() => void) | null = null;
	private closed = false;

	constructor(
		private readonly deviceId: string,
		private readonly server: string
	) {}

	async start(): Promise<void> {
		if (this.channelId || this.closed) throw new Error("This transport was already started.");
		const link = new MachineLink(this.deviceId);
		const { channelId } = await link.mcpOpen(this.server);
		if (this.closed) {
			// Closed while the machine was opening it.
			void link.mcpClose(channelId).catch(() => {});
			return;
		}
		this.channelId = channelId;
		this.sessionId = channelId;
		this.unregister = registerMcpChannel(this.deviceId, channelId, (event) => this.onEvent(event));
	}

	private onEvent(event: McpChannelEvent): void {
		if (this.closed) return;
		if (event.kind === "message") {
			const batch = Array.isArray(event.message) ? event.message : [event.message];
			for (const message of batch) {
				if (!isJsonRpc(message)) {
					this.onerror?.(new Error("The machine sent a frame that is not a JSON-RPC message."));
					continue;
				}
				this.onmessage?.(message);
			}
			return;
		}
		// The machine ended the channel, or the link dropped: nothing more will arrive on it.
		this.closed = true;
		this.unregister?.();
		this.unregister = null;
		if (event.reason === "crashed" || event.reason === "exited" || event.reason === "config") {
			this.onerror?.(
				new Error(`The local server ${event.reason}${event.detail ? `: ${event.detail}` : ""}`)
			);
		}
		this.onclose?.();
	}

	async send(message: Message): Promise<void> {
		if (this.closed || !this.channelId) {
			throw new OpError("unavailable", "The connection to the local server is closed.");
		}
		sendMcpMessage(this.deviceId, this.channelId, message);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unregister?.();
		this.unregister = null;
		const channelId = this.channelId;
		this.channelId = null;
		// Best effort: a machine that is gone has nothing left to close, and galopin also
		// closes a channel when the link drops.
		if (channelId) await new MachineLink(this.deviceId).mcpClose(channelId).catch(() => {});
		this.onclose?.();
	}
}

/**
 * The transport for a local server url (`localUrl.ts`), after checking it is the caller's own:
 * the person the url names must own the device, which must be paired. The url is the only
 * thing a caller supplies, so this is where a forged one (another person's device, a revoked
 * one) stops. Throws with a sentence the model and the person can be told.
 */
export async function createLocalTransport(url: string): Promise<MachineMcpTransport> {
	const target = parseLocalServerUrl(url);
	if (!target) throw new Error("That is not a local connector address.");
	if (!localConnectorsEnabled()) throw new Error("Local connectors are not enabled here.");
	const device = await collections.codeDevices.findOne({
		_id: new ObjectId(target.deviceId),
		userId: new ObjectId(target.userId),
		status: "paired",
	});
	if (!device) {
		logger.warn({ deviceId: target.deviceId }, "mcp_local_unowned_device");
		throw new Error("No such machine is paired to this account.");
	}
	return new MachineMcpTransport(target.deviceId, target.server);
}
