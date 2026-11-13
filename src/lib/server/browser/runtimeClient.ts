/**
 * Talking to a browser runtime over MCP (ADR 0116 §2): the six protocol tools, called on the
 * `cerea-browser` server of one of the user's own machines through the local-connector path
 * (`mcp/localTransport.ts`), and every answer parsed against the contract.
 *
 * The transport is injected (`RuntimeCall`) so the whole client is tested without a machine:
 * `fakeRuntime.ts` serves the same wire shape in process.
 */

import type { ZodType, ZodTypeDef } from "zod";
import { callMcpTool, type McpToolTextResponse } from "$lib/server/mcp/httpClient";
import { getClient } from "$lib/server/mcp/clientPool";
import { localServerUrl } from "$lib/server/mcp/localUrl";
import {
	BROWSER_RUNTIME_SERVER,
	BrowserRuntimeError,
	actResultSchema,
	diffSchema,
	downloadResultSchema,
	extractResultSchema,
	screenshotResultSchema,
	snapshotSchema,
	type ActResult,
	type ApprovalGrant,
	type BrowserAction,
	type BrowserRuntime,
	type Diff,
	type DownloadResult,
	type EndTaskResult,
	endTaskResultSchema,
	resumeResultSchema,
	openResultSchema,
	type OpenRequest,
	type OpenResult,
	tabsResultSchema,
	type ResumeResult,
	type TabsResult,
	type ExtractRequest,
	type ExtractResult,
	type RuntimeToolName,
	type ScreenshotResult,
	type Snapshot,
} from "./contract";

/** One call of a runtime tool. The default goes over MCP; tests pass the fake's. */
export type RuntimeCall = (
	tool: RuntimeToolName,
	args: Record<string, unknown>,
	signal?: AbortSignal
) => Promise<Pick<McpToolTextResponse, "text" | "isError" | "structured" | "content">>;

/** A step's own bound: one runtime call that does not answer in this long has failed. */
const RUNTIME_CALL_TIMEOUT_MS = 60_000;
/** Downloads can carry megabytes of base64; they get longer. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * One long-lived channel per (user, machine): `callMcpTool` takes the pooled client for the
 * server's url, so every call of a task, and the next task, goes over the one `mcp.open` channel
 * (one runtime process, one browser profile). `mcpRuntimeKeepAlive` pings that channel so a long
 * wait does not let the pool's or the machine's idle timeout close it.
 */
export function mcpRuntimeKeepAlive(target: {
	userId: string;
	deviceId: string;
}): () => Promise<void> {
	const server = {
		name: BROWSER_RUNTIME_SERVER,
		url: localServerUrl(target.userId, target.deviceId, BROWSER_RUNTIME_SERVER),
	};
	return async () => {
		const client = await getClient(server);
		await client.ping({ timeout: 10_000 });
	};
}

/** The default transport: the machine's `cerea-browser` server, as this user. */
export function mcpRuntimeCall(target: { userId: string; deviceId: string }): RuntimeCall {
	const server = {
		name: BROWSER_RUNTIME_SERVER,
		url: localServerUrl(target.userId, target.deviceId, BROWSER_RUNTIME_SERVER),
	};
	return (tool, args, signal) =>
		callMcpTool(server, tool, args, {
			signal,
			timeoutMs: tool === "download" ? DOWNLOAD_TIMEOUT_MS : RUNTIME_CALL_TIMEOUT_MS,
		});
}

function parseBody<T>(
	tool: RuntimeToolName,
	response: Awaited<ReturnType<RuntimeCall>>,
	schema: ZodType<T, ZodTypeDef, unknown>
): T {
	if (response.isError) {
		throw new BrowserRuntimeError(
			`The browser runtime reported an error in ${tool}: ${response.text.slice(0, 500) || "no detail"}`,
			"tool"
		);
	}
	let raw: unknown = response.structured;
	if (raw === undefined || raw === null) {
		try {
			raw = JSON.parse(response.text);
		} catch {
			throw new BrowserRuntimeError(
				`The browser runtime answered ${tool} with something that is not JSON.`,
				"protocol"
			);
		}
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new BrowserRuntimeError(
			`The browser runtime answered ${tool} in a shape this version does not understand: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
			"protocol"
		);
	}
	return parsed.data;
}

/** The first `image` content block of a result, as a screenshot. */
function imageOf(response: Awaited<ReturnType<RuntimeCall>>): ScreenshotResult | undefined {
	for (const block of response.content ?? []) {
		if (typeof block !== "object" || block === null) continue;
		const part = block as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (part.type === "image" && typeof part.data === "string") {
			return {
				mime: typeof part.mimeType === "string" ? part.mimeType : "image/png",
				base64: part.data,
			};
		}
	}
	return undefined;
}

export class McpBrowserRuntime implements BrowserRuntime {
	constructor(
		private readonly call: RuntimeCall,
		private readonly ping?: () => Promise<void>
	) {}

	async keepAlive(): Promise<void> {
		await this.ping?.();
	}

	endTask(options?: { keep?: boolean }, signal?: AbortSignal): Promise<EndTaskResult> {
		return this.invoke(
			"end_task",
			options?.keep ? { keep: true } : {},
			endTaskResultSchema,
			signal
		);
	}

	tabs(options?: { deny?: string[] }, signal?: AbortSignal): Promise<TabsResult> {
		// An empty list is sent too: the runtime then clears one it was given before.
		const deny = options?.deny?.filter((d) => d.length > 0);
		return this.invoke("tabs", deny ? { deny } : {}, tabsResultSchema, signal);
	}

	resume(token: string, signal?: AbortSignal): Promise<ResumeResult> {
		return this.invoke("resume", { token }, resumeResultSchema, signal);
	}

	open(request?: OpenRequest, signal?: AbortSignal): Promise<OpenResult> {
		const args: Record<string, unknown> = {};
		if (request?.url) args.url = request.url;
		if (request?.deny) args.deny = request.deny.filter((d) => d.length > 0);
		return this.invoke("open", args, openResultSchema, signal);
	}

	private async invoke<T>(
		tool: RuntimeToolName,
		args: Record<string, unknown>,
		schema: ZodType<T, ZodTypeDef, unknown>,
		signal?: AbortSignal
	): Promise<T> {
		let response: Awaited<ReturnType<RuntimeCall>>;
		try {
			response = await this.call(tool, args, signal);
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new BrowserRuntimeError(
				`The browser on that machine did not answer (${tool}): ${err instanceof Error ? err.message : String(err)}`,
				"unavailable"
			);
		}
		return parseBody(tool, response, schema);
	}

	snapshot(signal?: AbortSignal): Promise<Snapshot> {
		return this.invoke("snapshot", {}, snapshotSchema, signal);
	}

	diff(signal?: AbortSignal): Promise<Diff> {
		return this.invoke("diff", {}, diffSchema, signal);
	}

	act(
		actions: BrowserAction[],
		approvals: ApprovalGrant[] | undefined,
		signal?: AbortSignal
	): Promise<ActResult> {
		return this.invoke(
			"act",
			{ actions, ...(approvals && approvals.length > 0 ? { approvals } : {}) },
			actResultSchema,
			signal
		);
	}

	extract(request: ExtractRequest, signal?: AbortSignal): Promise<ExtractResult> {
		return this.invoke("extract", { ...request }, extractResultSchema, signal);
	}

	async screenshot(ref?: string, signal?: AbortSignal): Promise<ScreenshotResult> {
		let response: Awaited<ReturnType<RuntimeCall>>;
		try {
			response = await this.call("screenshot", ref ? { ref } : {}, signal);
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new BrowserRuntimeError(
				`The browser on that machine did not answer (screenshot): ${err instanceof Error ? err.message : String(err)}`,
				"unavailable"
			);
		}
		if (response.isError) {
			throw new BrowserRuntimeError(
				`The browser runtime reported an error in screenshot: ${response.text.slice(0, 300)}`,
				"tool"
			);
		}
		// An MCP image block is the contract; a JSON body with the same fields is tolerated.
		const image = imageOf(response);
		if (image) return image;
		return parseBody("screenshot", response, screenshotResultSchema);
	}

	download(signal?: AbortSignal): Promise<DownloadResult> {
		return this.invoke("download", {}, downloadResultSchema, signal);
	}
}
