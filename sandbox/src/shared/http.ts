import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Reads a request body, refusing at once (413) when it passes `max` bytes. */
export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
	const declared = Number(req.headers["content-length"] ?? "0");
	if (Number.isFinite(declared) && declared > max) {
		throw new HttpError(413, "body_too_large", `the body may be at most ${max} bytes`);
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > max) {
			throw new HttpError(413, "body_too_large", `the body may be at most ${max} bytes`);
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	});
	res.end(text);
}

export function sendError(
	res: ServerResponse,
	status: number,
	code: string,
	message: string
): void {
	sendJson(res, status, { error: { code, message } });
}

export function parseJson(buf: Buffer): unknown {
	try {
		return JSON.parse(buf.toString("utf8") || "{}");
	} catch {
		throw new HttpError(400, "bad_json", "the body is not valid JSON");
	}
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One JSON line on stdout. Never given a secret, a command or a body. */
export function logLine(fields: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...fields }) + "\n");
}
