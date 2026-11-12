import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { actionDigest } from "../src/classifier.ts";
import { signGrant } from "../src/grants.ts";
import {
	actResultSchema,
	diffSchema,
	downloadResultSchema,
	extractResultSchema,
	snapshotSchema,
	type ApprovalGrant,
	type ActResult,
	type BrowserAction,
	type Diff,
	type DownloadResult,
	type ExtractResult,
	type Snapshot,
	type SnapshotElement,
} from "../src/contract.ts";
import { createToolHandler } from "../src/server.ts";
import { BrowserSession } from "../src/session.ts";
import { startFixtures, type Fixtures } from "./fixtures.ts";

export const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef");

export interface Rig {
	fx: Fixtures;
	session: BrowserSession;
	call(name: string, args?: unknown): ReturnType<ReturnType<typeof createToolHandler>>;
	snapshot(): Promise<Snapshot>;
	diff(): Promise<Diff>;
	act(actions: unknown, approvals?: unknown): Promise<ActResult>;
	download(): Promise<DownloadResult>;
	extract(args?: unknown): Promise<ExtractResult>;
	goto(path: string): Promise<Snapshot>;
	ref(snap: Snapshot, role: string, name: string): string;
	element(snap: Snapshot, ref: string): SnapshotElement;
	/** The grant Cerea would issue for this action on this snapshot (its own classifier and digest). */
	grant(snap: Snapshot, action: BrowserAction, index?: number, id?: string, opts?: { exp?: number; key?: Buffer }): ApprovalGrant;
	close(): Promise<void>;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, result: { structuredContent?: unknown; content: Array<{ type: string; text?: string }>; isError?: boolean }): T {
	if (result.isError) throw new Error(`tool error: ${result.content[0]?.text}`);
	// Cerea reads structuredContent first, then the JSON text block: both must agree.
	const structured = result.structuredContent;
	const text = JSON.parse(result.content[0]!.text!);
	if (JSON.stringify(structured) !== JSON.stringify(text)) throw new Error("structuredContent and text differ");
	return schema.parse(structured);
}

export async function rig(options: { maxSnapshotChars?: number } = {}): Promise<Rig> {
	const fx = await startFixtures();
	const profile = await mkdtemp(join(tmpdir(), "cerea-browser-test-"));
	const keyFile = join(profile, "..", `key-${Math.random().toString(36).slice(2)}`);
	await writeFile(keyFile, TEST_KEY.toString("base64url"), { mode: 0o600 });
	const session = new BrowserSession({
		profileDir: profile,
		headless: true,
		noSandbox: process.env.CEREA_TEST_NO_SANDBOX === "1",
		executablePath: process.env.CEREA_BROWSER_EXECUTABLE || undefined,
		keyFile,
		maxSnapshotChars: options.maxSnapshotChars,
	});
	const handler = createToolHandler(session);
	const r: Rig = {
		fx,
		session,
		call: (name, args) => handler(name, args ?? {}),
		snapshot: async () => parse(snapshotSchema, await handler("snapshot", {})),
		diff: async () => parse(diffSchema, await handler("diff", {})),
		act: async (actions, approvals) =>
			parse(actResultSchema, await handler("act", { actions, ...(approvals ? { approvals } : {}) })),
		download: async () => parse(downloadResultSchema, await handler("download", {})),
		extract: async (args) => parse(extractResultSchema, await handler("extract", args ?? {})),
		goto: async (path) => {
			const url = path.startsWith("http") ? path : fx.base + path;
			// A test's own setup navigates directly: approvals are what the tests of `act` are about.
			await r.session.withPage((page) => page.goto(url, { waitUntil: "load" }));
			return r.snapshot();
		},
		ref(snap, role, name) {
			const el = snap.elements.find((e) => e.role === role && e.name === name);
			if (!el) throw new Error(`no ${role} "${name}" in:\n${snap.text}`);
			return el.ref;
		},
		element(snap, ref) {
			const el = snap.elements.find((e) => e.ref === ref);
			if (!el) throw new Error(`no ref ${ref}`);
			return el;
		},
		grant(snap, action, index = 0, id = `approval-${Math.random().toString(36).slice(2)}`, opts = {}) {
			const element = "ref" in action && action.ref ? snap.elements.find((e) => e.ref === action.ref) : undefined;
			const digest = actionDigest(action, { element, currentUrl: snap.url });
			const exp = opts.exp ?? Date.now() + 60_000;
			return { index, id, digest, exp, sig: signGrant(opts.key ?? TEST_KEY, id, digest, exp) };
		},
		close: async () => {
			await session.close();
			await fx.close();
			await rm(profile, { recursive: true, force: true });
			await rm(keyFile, { force: true });
		},
	};
	return r;
}
