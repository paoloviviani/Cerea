/**
 * The MCP reverse path, Cerea's half (ADR 0108, item 3; PROTOCOL.md §5 "Machine calls", family
 * `connector`): a coding agent on a machine reaches the connectors its user opted the session in
 * to. The machine lists them (`connector.list`) and calls one tool (`connector.call`); Cerea runs
 * the call with the user's own credentials, which never cross the link: the answer carries tool
 * names, schemas and text, never a header, token or key.
 *
 * Which connectors a session may use is `sessionConnectors.ts` (the user's opt-in, default none)
 * intersected with the chat's resolver (ADR 0104: deployment modes, the user's switches, sign-ins
 * and keys), so another user's connector is never listed and a connector switched off after the
 * opt-in stops working at once. The call is bounded in time and size, audited, and rate-limited
 * per machine. Whether a call needs the user's approval is the machine's decision (the `tools`
 * class, ADR 0107), made before the call is sent.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { CallError } from "$lib/server/code/machineCallError";
import { connectorsNow } from "$lib/server/code/sessionConnectors";
import { callMcpTool } from "$lib/server/mcp/httpClient";
import { listMcpServerTools } from "$lib/server/mcp/tools";
import type { TurnConnector } from "$lib/server/mcp/turnConnectors";
import type { CallErrorCode, CallFrame, CallResFrame } from "$lib/types/machineProtocol";

export const CONNECTOR_CALL_OPS: string[] = ["connector.list", "connector.call"];

/** Cerea's bound on one call; the machine waits a little longer, so this answer arrives first. */
export const CONNECTOR_CALL_TIMEOUT_MS = 80_000;
/** The most text one call hands back; the rest is cut, and says so. */
export const MAX_RESULT_CHARS = 200_000;
/** Calls per machine per minute. */
export const MAX_CALLS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

const callArgs = z.object({
	connector: z.string().min(1).max(300),
	tool: z.string().min(1).max(200),
	arguments: z.record(z.string(), z.unknown()).optional(),
});

const recent = new Map<string, number[]>();

function underRate(deviceId: string, now = Date.now()): boolean {
	const times = (recent.get(deviceId) ?? []).filter((t) => now - t < MINUTE_MS);
	if (times.length >= MAX_CALLS_PER_MINUTE) {
		recent.set(deviceId, times);
		return false;
	}
	times.push(now);
	recent.set(deviceId, times);
	return true;
}

/** Test hook: forget the rate window. */
export function resetConnectorRate(): void {
	recent.clear();
}

type ToolView = { name: string; description?: string; inputSchema?: Record<string, unknown> };

async function listOne(c: TurnConnector): Promise<{
	id: string;
	name: string;
	summary: string;
	tools: ToolView[];
	note?: string;
}> {
	const base = { id: c.key, name: c.name, summary: c.summary };
	try {
		const opened = await c.open();
		if (!("server" in opened)) {
			return { ...base, tools: [], note: `not available: ${opened.unavailable}` };
		}
		return {
			...base,
			tools: await listMcpServerTools(opened.server, {
				signal: AbortSignal.timeout(20_000),
			}),
		};
	} catch (err) {
		logger.info({ connector: c.name, err: String(err) }, "agent connector list failed");
		return { ...base, tools: [], note: "its tools could not be listed right now" };
	}
}

async function opList(ctx: Ctx) {
	const now = await connectorsNow(ctx.userId, ctx.deviceId, ctx.frame.rootSessionId);
	return {
		// One bad connector does not fail the list: it carries a note instead.
		connectors: await Promise.all(now.cerea.map(listOne)),
		local: now.local,
	};
}

/** What a failed call means for the agent, without the service's own error text. */
function mapFailure(err: unknown, name: string): CallError {
	const message = String(err instanceof Error ? err.message : err).toLowerCase();
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden/.test(message)) {
		return new CallError(
			"forbidden",
			`${name} refused the user's sign-in or key. They need to reconnect it under Workspace, Connectors.`
		);
	}
	if (/abort|timed? ?out|timeout|without a response/.test(message)) {
		return new CallError(
			"unavailable",
			`${name} did not answer within ${CONNECTOR_CALL_TIMEOUT_MS / 1000} seconds.`
		);
	}
	return new CallError("unavailable", `${name} could not be reached right now.`);
}

function textOf(response: Awaited<ReturnType<typeof callMcpTool>>): string {
	if (response.inputRequired) {
		return "This tool asked for more input, which an agent cannot give. Try again with different arguments.";
	}
	const parts: string[] = [];
	if (response.text) parts.push(response.text);
	for (const block of response.content ?? []) {
		const type = (block as { type?: unknown } | null)?.type;
		if (typeof type === "string" && type !== "text") parts.push(`[${type} content not shown]`);
	}
	if (parts.length === 0 && response.structured !== undefined) {
		parts.push(JSON.stringify(response.structured));
	}
	const text = parts.join("\n");
	return text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)}\n[result cut: ${MAX_RESULT_CHARS} of ${text.length} characters shown]`
		: text;
}

async function opCall(ctx: Ctx) {
	const parsed = callArgs.safeParse(ctx.frame.args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new CallError(
			"invalid",
			`The arguments are not valid (${issue?.path.join(".")}): ${issue?.message}.`
		);
	}
	const { connector: key, tool, arguments: args } = parsed.data;
	const now = await connectorsNow(ctx.userId, ctx.deviceId, ctx.frame.rootSessionId);
	const connector = now.cerea.find((c) => c.key === key);
	if (!connector) {
		throw new CallError(
			"forbidden",
			"That connector is not switched on for this session, or is not available to the user right now. Use connector_list."
		);
	}
	if (!underRate(ctx.deviceId)) {
		throw new CallError(
			"limit",
			`Too many connector calls from this machine: at most ${MAX_CALLS_PER_MINUTE} a minute.`
		);
	}
	const opened = await connector.open().catch(() => ({ unavailable: "it could not be opened" }));
	if (!("server" in opened)) {
		throw new CallError(
			"forbidden",
			`${connector.name} is not usable: ${opened.unavailable}. The user can fix it under Workspace, Connectors.`
		);
	}
	try {
		const listed = await listMcpServerTools(opened.server, { signal: AbortSignal.timeout(20_000) });
		if (!listed.some((t) => t.name === tool)) {
			throw new CallError(
				"not_found",
				`${connector.name} has no tool called ${tool}. Use connector_list.`
			);
		}
		const response = await callMcpTool(opened.server, tool, args ?? {}, {
			timeoutMs: CONNECTOR_CALL_TIMEOUT_MS,
		});
		const isError = response.isError === true || Boolean(response.inputRequired);
		await audit(ctx, isError ? "error" : "ok", `${connector.name}: ${tool}`);
		return { isError, text: textOf(response) };
	} catch (err) {
		const failure = err instanceof CallError ? err : mapFailure(err, connector.name);
		await audit(ctx, failure.code, `${connector.name}: ${tool}`);
		throw failure;
	}
}

interface Ctx {
	frame: CallFrame;
	deviceId: string;
	userId: ObjectId;
}

/** One row per call: which connector and tool, and the outcome. Never the arguments or the result. */
async function audit(ctx: Ctx, outcome: string, name: string): Promise<void> {
	await recordCodeAuditRow(ctx.userId, {
		action: "connector.call",
		deviceId: ctx.deviceId,
		sessionId: ctx.frame.sessionId,
		origin: "agent",
		outcome,
		name: name.slice(0, 80),
	});
}

/** Answer one `connector.*` call from the device `deviceId`. Never throws. */
export async function handleConnectorCall(
	deviceId: string,
	frame: CallFrame
): Promise<CallResFrame> {
	const fail = (code: CallErrorCode, message: string): CallResFrame => ({
		type: "callres",
		id: frame.id,
		ok: false,
		error: { code, message },
	});
	let ctx: Ctx;
	try {
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		if (!device) return fail("forbidden", "This machine is not known to Cerea.");
		if (device.status !== "paired") {
			return fail("forbidden", "This machine is not paired yet; its owner must confirm it.");
		}
		ctx = { frame, deviceId, userId: device.userId };
	} catch (err) {
		logger.warn({ err: String(err), deviceId }, "connector call: device lookup failed");
		return fail("unavailable", "Cerea could not look this machine up; try again.");
	}
	try {
		const result = frame.op === "connector.list" ? await opList(ctx) : await opCall(ctx);
		return { type: "callres", id: frame.id, ok: true, result };
	} catch (err) {
		if (err instanceof CallError) return fail(err.code, err.message);
		logger.error({ err, deviceId, op: frame.op }, "connector call failed");
		return fail("unavailable", "Cerea could not do that just now; try again.");
	}
}
