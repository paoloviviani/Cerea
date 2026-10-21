import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { logRedact } from "./logger";

describe("logger redaction", () => {
	it("masks credentials in whatever object reaches it", () => {
		let out = "";
		const sink = new Writable({
			write(chunk, _enc, cb) {
				out += chunk.toString();
				cb();
			},
		});
		pino({ redact: logRedact }, sink).error({
			locals: { token: "TOK", sessionId: "SESS", isAdmin: true },
			headers: { authorization: "Bearer TOK", cookie: "c=SESS" },
			request: { headers: { authorization: "Bearer TOK", cookie: "c=SESS" } },
			sessionId: "agent-session-visible",
		});
		expect(out).not.toContain("TOK");
		expect(out).not.toContain("SESS");
		expect(out).toContain("agent-session-visible");
		expect(out).toContain("[Redacted]");
	});
});
