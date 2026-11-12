import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { actionDigest } from "../src/classifier.ts";
import { signGrant } from "../src/grants.ts";
import {
	actResultSchema,
	actionResultSchema,
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
import { challengeSchema, tabsResultSchema, useTabDigest } from "../src/extensions.ts";
import { createToolHandler } from "../src/server.ts";
import { BrowserSession } from "../src/session.ts";
import { startFixtures, type Fixtures } from "./fixtures.ts";

// What the runtime sends beyond Cerea's current contract copy (src/extensions.ts).
const actionResultX = actionResultSchema.extend({
	refused: z
		.enum([
			"approval_required",
			"approval_mismatch",
			"approval_expired",
			"scheme_refused",
			"challenge",
		])
		.optional(),
});
const actResultX = actResultSchema.extend({ results: z.array(actionResultX) });
const snapshotX = snapshotSchema.extend({ challenge: challengeSchema.optional() });
const diffX = diffSchema.extend({ challenge: challengeSchema.optional() });
export type SnapshotX = z.infer<typeof snapshotX>;
export type ActResultX = z.infer<typeof actResultX>;

export const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef");

export interface Rig {
	fx: Fixtures;
	session: BrowserSession;
	profile: string;
	stateDir: string;
	keyFile: string;
	call(name: string, args?: unknown): ReturnType<ReturnType<typeof createToolHandler>>;
	snapshot(): Promise<SnapshotX>;
	diff(): Promise<z.infer<typeof diffX>>;
	act(actions: unknown, approvals?: unknown): Promise<ActResultX>;
	tabs(): Promise<z.infer<typeof tabsResultSchema>>;
	/** A grant for a digest Cerea would compute (use_tab and the like). */
	signed(digest: string, index?: number, id?: string): ApprovalGrant;
	useTabGrant(tab: { id: string; url: string; title: string }, index?: number): ApprovalGrant;
	download(): Promise<DownloadResult>;
	extract(args?: unknown): Promise<ExtractResult>;
	goto(path: string): Promise<SnapshotX>;
	ref(snap: SnapshotX, role: string, name: string): string;
	element(snap: SnapshotX, ref: string): SnapshotElement;
	/** The grant Cerea would issue for this action on this snapshot (its own classifier and digest). */
	grant(
		snap: Snapshot,
		action: BrowserAction,
		index?: number,
		id?: string,
		opts?: { exp?: number; key?: Buffer }
	): ApprovalGrant;
	close(): Promise<void>;
}

function parse<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	result: {
		structuredContent?: unknown;
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	}
): T {
	if (result.isError) throw new Error(`tool error: ${result.content[0]?.text}`);
	// Cerea reads structuredContent first, then the JSON text block: both must agree.
	const structured = result.structuredContent;
	const text = JSON.parse(result.content[0]!.text!);
	if (JSON.stringify(structured) !== JSON.stringify(text))
		throw new Error("structuredContent and text differ");
	return schema.parse(structured);
}

export async function rig(
	options: {
		maxSnapshotChars?: number;
		actionBudgetMs?: number;
		keptTtlMs?: number;
		idleMs?: number;
		pace?: { minMs: number; maxMs: number };
	} = {}
): Promise<Rig> {
	const fx = await startFixtures();
	const profile = await mkdtemp(join(tmpdir(), "cerea-browser-test-"));
	const keyFile = join(profile, "..", `key-${Math.random().toString(36).slice(2)}`);
	await writeFile(keyFile, TEST_KEY.toString("base64url"), { mode: 0o600 });
	const stateDir = join(profile, "..", `state-${Math.random().toString(36).slice(2)}`);
	const session = new BrowserSession({
		stateDir,
		actionBudgetMs: options.actionBudgetMs,
		keptTtlMs: options.keptTtlMs,
		idleMs: options.idleMs,
		pace: options.pace,
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
		profile,
		stateDir,
		keyFile,
		call: (name, args) => handler(name, args ?? {}),
		snapshot: async () => parse(snapshotX, await handler("snapshot", {})),
		diff: async () => parse(diffX, await handler("diff", {})),
		act: async (actions, approvals) =>
			parse(actResultX, await handler("act", { actions, ...(approvals ? { approvals } : {}) })),
		download: async () => parse(downloadResultSchema, await handler("download", {})),
		tabs: async () => parse(tabsResultSchema, await handler("tabs", {})),
		signed(digest, index = 0, id = `approval-${Math.random().toString(36).slice(2)}`) {
			const exp = Date.now() + 60_000;
			return { index, id, digest, exp, sig: signGrant(TEST_KEY, id, digest, exp) };
		},
		useTabGrant(tab, index = 0) {
			return r.signed(useTabDigest(tab), index);
		},
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
		grant(
			snap,
			action,
			index = 0,
			id = `approval-${Math.random().toString(36).slice(2)}`,
			opts = {}
		) {
			const element =
				"ref" in action && action.ref ? snap.elements.find((e) => e.ref === action.ref) : undefined;
			const digest = actionDigest(action, { element, currentUrl: snap.url });
			const exp = opts.exp ?? Date.now() + 60_000;
			return { index, id, digest, exp, sig: signGrant(opts.key ?? TEST_KEY, id, digest, exp) };
		},
		close: async () => {
			await session.close();
			await fx.close();
			await rm(profile, { recursive: true, force: true });
			await rm(keyFile, { force: true });
			await rm(stateDir, { recursive: true, force: true });
		},
	};
	return r;
}
