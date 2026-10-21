import pino from "pino";
import { dev } from "$app/environment";
import { config } from "$lib/server/config";
import { getRequestContext } from "$lib/server/requestContext";

/** Credential fields masked in every log line, whatever object carries them. */
export const logRedact = {
	paths: [
		"token",
		// Request locals hold the auth session id (the code routes log their own,
		// non-secret, agent `sessionId` and that stays readable).
		"locals.sessionId",
		"*.locals.sessionId",
		"accessToken",
		"refreshToken",
		"authorization",
		"cookie",
		"*.token",
		"*.accessToken",
		"*.refreshToken",
		"*.authorization",
		"*.cookie",
		"headers.authorization",
		"headers.cookie",
		'headers["set-cookie"]',
		"*.headers.authorization",
		"*.headers.cookie",
		'*.headers["set-cookie"]',
	],
	censor: "[Redacted]",
};

let options: pino.LoggerOptions = {};

if (dev) {
	options = {
		transport: {
			target: "pino-pretty",
			options: {
				colorize: true,
			},
		},
	};
}

const baseLogger = pino({
	...options,
	messageKey: "message",
	// Second layer: whatever object reaches the logger, credentials are masked.
	redact: logRedact,
	level: config.LOG_LEVEL || "info",
	formatters: {
		level: (label) => {
			return { level: label };
		},
	},
	mixin() {
		const ctx = getRequestContext();
		if (!ctx) return {};

		const result: Record<string, string | number> = {};
		if (ctx.requestId) result.request_id = ctx.requestId;
		if (ctx.url) result.url = ctx.url;
		if (ctx.ip) result.ip = ctx.ip;
		if (ctx.user) result.user = ctx.user;
		if (ctx.statusCode) result.status_code = ctx.statusCode;
		return result;
	},
});

export const logger = baseLogger;
