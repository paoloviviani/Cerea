/**
 * The browser-side half of the terminal binary codec (PROTOCOL.md §9.2).
 * Wire-identical to `encodeBinaryFrame`/`decodeBinaryFrame` in
 * `$lib/types/machineProtocol.ts`, but built on `Uint8Array`/`DataView`
 * rather than Node's `Buffer` — that module is also imported for its types
 * by server-only code, and pulling `Buffer` into the client bundle would
 * need a polyfill this deployment does not otherwise carry. Two small,
 * clearly-paired implementations of one 20-line format beat one shared
 * implementation plus a bundler shim.
 */
import {
	BIN_TERM_OUTPUT,
	BIN_TERM_INPUT,
	BIN_TERM_ACK,
	MAX_CHANNEL_ID_LEN,
} from "$lib/types/machineProtocol";

export { BIN_TERM_OUTPUT, BIN_TERM_INPUT, BIN_TERM_ACK };

export interface BrowserBinaryFrame {
	kind: number;
	channel: string;
	offset: number;
	payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("ascii");

export function encodeTerminalFrame(frame: BrowserBinaryFrame): Uint8Array {
	const channelBytes = encoder.encode(frame.channel);
	if (channelBytes.length < 1 || channelBytes.length > MAX_CHANNEL_ID_LEN) {
		throw new Error(`terminal frame: channel id length out of range: got ${channelBytes.length}`);
	}
	const out = new Uint8Array(2 + channelBytes.length + 8 + frame.payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, frame.kind);
	view.setUint8(1, channelBytes.length);
	out.set(channelBytes, 2);
	view.setBigUint64(2 + channelBytes.length, BigInt(frame.offset), false);
	out.set(frame.payload, 2 + channelBytes.length + 8);
	return out;
}

export function decodeTerminalFrame(raw: ArrayBuffer): BrowserBinaryFrame | null {
	const bytes = new Uint8Array(raw);
	if (bytes.length < 2) return null;
	const view = new DataView(raw);
	const kind = view.getUint8(0);
	const channelLen = view.getUint8(1);
	if (channelLen < 1 || channelLen > MAX_CHANNEL_ID_LEN) return null;
	if (bytes.length < 2 + channelLen + 8) return null;
	const channel = decoder.decode(bytes.subarray(2, 2 + channelLen));
	const offset = view.getBigUint64(2 + channelLen, false);
	if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	const payload = bytes.subarray(2 + channelLen + 8);
	return { kind, channel, offset: Number(offset), payload };
}
