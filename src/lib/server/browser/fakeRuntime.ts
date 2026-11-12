/**
 * A fake browser runtime for tests: the contract (`contract.ts`) over a scripted page model, in
 * process. It stands in for the engine on a user's machine, so the loop, the approvals and the
 * downloads are tested end to end without a browser.
 *
 * It behaves like the real runtime where the contract says so: refs are stable, `diff` reports
 * only what changed since the last snapshot (a full snapshot after navigation), `act` stops at
 * the first failure, and **a commit-class action without a grant matching it exactly is refused**
 * (the runtime's own half of ADR 0116 §4, using the same classifier and digest as Cerea).
 *
 * `asRuntimeCall()` serves the same behaviour at the wire level (JSON text, MCP image blocks), so
 * `McpBrowserRuntime` is tested against it too.
 */

import {
	type ActResult,
	type ActionResult,
	type ApprovalGrant,
	type BrowserAction,
	type BrowserRuntime,
	type Diff,
	type DownloadResult,
	type ExtractResult,
	type RuntimeToolName,
	type ScreenshotResult,
	type Snapshot,
	type SnapshotElement,
	BrowserRuntimeError,
	browserActionSchema,
} from "./contract";
import { actionDigest, classifyAction } from "./classifier";
import type { RuntimeCall } from "./runtimeClient";

export interface FakeEffect {
	/** Navigate to the page with this id. */
	goto?: string;
	/** Offer a file for download. */
	download?: { name: string; mime?: string; content: string | Buffer };
	/** Add elements to the page. */
	reveal?: FakeElement[];
	/** Fail with this message. */
	fail?: string;
}

export type FakeElement = SnapshotElement & { onClick?: FakeEffect };

export interface FakePage {
	id: string;
	url: string;
	title: string;
	elements: FakeElement[];
	/** What `extract` returns on this page. */
	extract?: unknown;
}

/** A 1x1 PNG. */
export const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function renderElement(el: SnapshotElement): string {
	const bits = [`[${el.ref}]`, el.role, el.name ? `"${el.name}"` : ""];
	if (el.value) bits.push(`= "${el.value}"`);
	return bits.filter(Boolean).join(" ");
}

export class FakeBrowserRuntime implements BrowserRuntime {
	/** Every protocol call, in order, for assertions. */
	readonly calls: Array<{ tool: RuntimeToolName; args: Record<string, unknown> }> = [];
	/** Actions the fake really performed (not refused). */
	readonly performed: BrowserAction[] = [];
	/** Make the next call of a tool throw (a runtime that went away). */
	failNext: Partial<Record<RuntimeToolName, Error>> = {};

	private readonly pages = new Map<string, FakePage>();
	private currentId: string;
	private baseline = new Map<string, string>();
	private baselineUrl = "";
	private captured: Array<{ name: string; mime: string; content: Buffer }> = [];
	private current: FakePage;

	constructor(pages: FakePage[], start?: string) {
		for (const page of pages) {
			this.pages.set(page.id, {
				...page,
				elements: page.elements.map((e) => ({ ...e })),
			});
		}
		this.currentId = start ?? pages[0].id;
		const first = this.pages.get(this.currentId);
		if (!first) throw new Error(`No such page ${this.currentId}`);
		this.current = first;
	}

	get url(): string {
		return this.current.url;
	}

	private record(tool: RuntimeToolName, args: Record<string, unknown>): void {
		this.calls.push({ tool, args });
		const failure = this.failNext[tool];
		if (failure) {
			delete this.failNext[tool];
			throw failure;
		}
	}

	private strip(el: FakeElement): SnapshotElement {
		const { onClick: _onClick, ...rest } = el;
		void _onClick;
		return rest;
	}

	private fingerprint(el: SnapshotElement): string {
		return JSON.stringify([el.role, el.name, el.value ?? "", el.disabled ?? false]);
	}

	private take(): Snapshot {
		const elements = this.current.elements.map((e) => this.strip(e));
		this.baseline = new Map(elements.map((e) => [e.ref, this.fingerprint(e)]));
		this.baselineUrl = this.current.url;
		return {
			url: this.current.url,
			title: this.current.title,
			text: elements.map(renderElement).join("\n"),
			elements,
		};
	}

	async snapshot(): Promise<Snapshot> {
		this.record("snapshot", {});
		return this.take();
	}

	async diff(): Promise<Diff> {
		this.record("diff", {});
		if (this.baselineUrl !== this.current.url) {
			const snapshot = this.take();
			return {
				url: snapshot.url,
				title: snapshot.title,
				navigated: true,
				added: [],
				changed: [],
				removed: [],
				text: snapshot.text,
				snapshot,
			};
		}
		const now = this.current.elements.map((e) => this.strip(e));
		const added = now.filter((e) => !this.baseline.has(e.ref));
		const changed = now.filter(
			(e) => this.baseline.has(e.ref) && this.baseline.get(e.ref) !== this.fingerprint(e)
		);
		const refs = new Set(now.map((e) => e.ref));
		const removed = [...this.baseline.keys()].filter((ref) => !refs.has(ref));
		this.baseline = new Map(now.map((e) => [e.ref, this.fingerprint(e)]));
		const lines = [
			...added.map((e) => `+ ${renderElement(e)}`),
			...changed.map((e) => `~ ${renderElement(e)}`),
			...removed.map((ref) => `- [${ref}]`),
		];
		return {
			url: this.current.url,
			title: this.current.title,
			navigated: false,
			added,
			changed,
			removed,
			text: lines.length > 0 ? lines.join("\n") : "(no change)",
		};
	}

	async act(actions: BrowserAction[], approvals?: ApprovalGrant[]): Promise<ActResult> {
		this.record("act", { actions, ...(approvals ? { approvals } : {}) });
		const results: ActionResult[] = [];
		const downloads: Array<{ name: string; mime?: string }> = [];
		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index];
			const element =
				"ref" in action && action.ref
					? this.current.elements.find((e) => e.ref === action.ref)
					: undefined;
			if ("ref" in action && action.ref && !element) {
				results.push({ ok: false, error: `No element with ref ${action.ref} on this page.` });
				break;
			}
			const ctx = {
				element: element ? this.strip(element) : undefined,
				currentUrl: this.current.url,
			};
			// The runtime's own refusal: a commit needs a grant for exactly this action.
			if (classifyAction(action, ctx).class === "commit") {
				const grant = approvals?.find((a) => a.index === index);
				if (!grant) {
					results.push({ ok: false, refused: "approval_required", error: "approval required" });
					break;
				}
				if (grant.digest !== actionDigest(action, ctx)) {
					results.push({
						ok: false,
						refused: "approval_mismatch",
						error: "approval does not match",
					});
					break;
				}
			}
			const outcome = this.perform(action, element, downloads);
			results.push(outcome);
			if (!outcome.ok) break;
			this.performed.push(action);
		}
		return {
			results,
			url: this.current.url,
			title: this.current.title,
			...(downloads.length > 0 ? { downloads } : {}),
		};
	}

	private perform(
		action: BrowserAction,
		element: FakeElement | undefined,
		downloads: Array<{ name: string; mime?: string }>
	): ActionResult {
		switch (action.type) {
			case "click": {
				const effect = element?.onClick;
				if (element?.disabled) return { ok: false, error: `${element.name} is disabled.` };
				if (effect?.fail) return { ok: false, error: effect.fail };
				if (effect?.reveal) this.current.elements.push(...effect.reveal.map((e) => ({ ...e })));
				if (effect?.download) {
					const content = Buffer.from(effect.download.content);
					this.captured.push({
						name: effect.download.name,
						mime: effect.download.mime ?? "application/octet-stream",
						content,
					});
					downloads.push({ name: effect.download.name, mime: effect.download.mime });
				}
				if (effect?.goto) return this.goto(effect.goto, "clicked");
				return { ok: true, outcome: "clicked" };
			}
			case "fill":
				if (element) element.value = element.inputType === "password" ? undefined : action.text;
				return { ok: true, outcome: `typed ${action.text.length} characters` };
			case "select":
				if (element) element.value = action.value;
				return { ok: true, outcome: `chose ${action.value}` };
			case "press":
				return { ok: true, outcome: `pressed ${action.key}` };
			case "scroll":
				return { ok: true, outcome: `scrolled ${action.direction}` };
			case "wait_for":
				return { ok: true, outcome: "waited" };
			case "navigate": {
				const page = [...this.pages.values()].find((p) => p.url === action.url);
				if (!page) return { ok: false, error: `Could not load ${action.url}.` };
				return this.goto(page.id, "navigated");
			}
		}
	}

	private goto(id: string, outcome: string): ActionResult {
		const page = this.pages.get(id);
		if (!page) return { ok: false, error: `No such page ${id}.` };
		this.currentId = id;
		this.current = page;
		return { ok: true, outcome };
	}

	async extract(schema: Record<string, unknown>): Promise<ExtractResult> {
		this.record("extract", { schema });
		return { data: this.current.extract ?? {} };
	}

	async screenshot(ref?: string): Promise<ScreenshotResult> {
		this.record("screenshot", ref ? { ref } : {});
		if (ref && !this.current.elements.some((e) => e.ref === ref)) {
			throw new BrowserRuntimeError(`No element with ref ${ref}.`, "tool");
		}
		return { mime: "image/png", base64: TINY_PNG_BASE64 };
	}

	async download(): Promise<DownloadResult> {
		this.record("download", {});
		const files = this.captured.map((file) => ({
			name: file.name,
			mime: file.mime,
			size: file.content.byteLength,
			base64: file.content.toString("base64"),
		}));
		this.captured = [];
		return { files };
	}

	/** The same runtime at the wire level: what an MCP server would answer, for `McpBrowserRuntime`. */
	asRuntimeCall(): RuntimeCall {
		return async (tool, args) => {
			const json = (value: unknown) => ({
				text: JSON.stringify(value),
				isError: false as const,
			});
			try {
				switch (tool) {
					case "snapshot":
						return json(await this.snapshot());
					case "diff":
						return json(await this.diff());
					case "act": {
						const actions = (args.actions as unknown[]).map((a) => browserActionSchema.parse(a));
						return json(await this.act(actions, args.approvals as ApprovalGrant[] | undefined));
					}
					case "extract":
						return json(await this.extract((args.schema as Record<string, unknown>) ?? {}));
					case "screenshot": {
						const shot = await this.screenshot(args.ref as string | undefined);
						return {
							text: "",
							isError: false,
							content: [{ type: "image", data: shot.base64, mimeType: shot.mime }],
						};
					}
					case "download":
						return json(await this.download());
				}
			} catch (err) {
				return { text: err instanceof Error ? err.message : String(err), isError: true };
			}
		};
	}
}
