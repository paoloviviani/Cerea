/**
 * The browser: one persistent Chromium context, the tabs in it, and the six protocol operations.
 *
 * Calls are serialised by the caller (`server.ts`), so nothing here is re-entrant. Phase 2 (live
 * view, takeover) hooks in through `withPage`: a CDP session is opened from the active page, and
 * a takeover pauses the protocol operations by holding the same queue.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chromium,
	type BrowserContext,
	type Download,
	type Locator,
	type Page,
} from "playwright-core";
import { actionDigest, classifyAction, type ClassifyContext } from "./classifier.ts";
import { checkGrant, readKey, type GrantCheck } from "./grants.ts";
import {
	MAX_DOWNLOAD_BYTES,
	type ActResult,
	type ActionResult,
	type ApprovalGrant,
	type BrowserAction,
	type Diff,
	type DownloadResult,
	type ExtractResult,
	type Snapshot,
	type SnapshotElement,
} from "./contract.ts";
import { ToolError } from "./errors.ts";
import { pageExtract, shapeExtract, type ExtractOptions, type RawExtract } from "./extract.ts";
import { playwrightKey } from "./keys.ts";
import { clean, safeFileName } from "./sanitize.ts";
import {
	collapse,
	fit,
	layout,
	render,
	toElement,
	type AriaChild,
	type AriaNode,
	type DomMeta,
} from "./tree.ts";

export interface SessionOptions {
	/** The persistent Chromium profile: cookies and logins live here. */
	profileDir: string;
	headless: boolean;
	noSandbox?: boolean;
	executablePath?: string;
	/** Size budget of one snapshot, in characters (about 3.5 per token). */
	maxSnapshotChars?: number;
	viewport?: { width: number; height: number };
	/** Task pages are closed after this long without a call (default 10 minutes). */
	idleMs?: number;
	/** Where Cerea's approval key for this device is kept (0600). Else `$CEREA_BROWSER_KEY`. */
	keyFile?: string;
}

export const DEFAULT_MAX_SNAPSHOT_CHARS = 9_000;
const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const META_TIMEOUT_MS = 1_500;
const MAX_DOWNLOADS = 20;
const ACTION_BUDGET_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60_000;

interface Entry {
	line: string;
	element: SnapshotElement;
}
interface Baseline {
	page: Page;
	seq: number;
	url: string;
	entries: Map<string, Entry>;
	textLines: string[];
}
interface Captured {
	name: string;
	mime: string;
	path?: string;
	size: number;
	skipped?: string;
	/** The action of the `act` batch that produced it, and the grant id that covered it. */
	actionIndex?: number;
	grantId?: string;
}
interface Built {
	snapshot: Snapshot;
	entries: Map<string, Entry>;
	textLines: string[];
}

const MIME_BY_EXTENSION: Record<string, string> = {
	csv: "text/csv",
	pdf: "application/pdf",
	zip: "application/zip",
	json: "application/json",
	txt: "text/plain",
	xml: "application/xml",
	html: "text/html",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gz: "application/gzip",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Runs inside the page: the facts about an element that only the DOM has. */
function pageMeta(el: Element): DomMeta {
	const tag = el.tagName.toLowerCase();
	const control = el as HTMLInputElement & HTMLButtonElement;
	const form = (control.form ?? el.closest("form")) as HTMLFormElement | null;
	const type = tag === "input" ? (control.type || "text").toLowerCase() : undefined;
	let formId: string | undefined;
	if (form) {
		const index = Array.prototype.indexOf.call(document.forms, form);
		formId = form.id || form.getAttribute("name") || `form${index + 1}`;
	}
	const submitter =
		(tag === "button" && (control.type === "submit" || !control.getAttribute("type"))) ||
		(tag === "input" && (type === "submit" || type === "image"));
	const rawMethod = (
		el.getAttribute("formmethod") ||
		form?.getAttribute("method") ||
		"get"
	).toLowerCase();
	const anchor = el.closest("a");
	return {
		...(type ? { inputType: type } : {}),
		...(formId ? { form: formId } : {}),
		...(form && (rawMethod === "get" || rawMethod === "post")
			? { formMethod: rawMethod as "get" | "post" }
			: {}),
		...(submitter && form ? { submits: true } : {}),
		...(form
			? (() => {
					try {
						const action = new URL(
							el.getAttribute("formaction") || form.getAttribute("action") || location.href,
							location.href
						);
						return action.protocol === "http:" || action.protocol === "https:"
							? { formActionHost: action.hostname.toLowerCase() }
							: {};
					} catch {
						return {};
					}
				})()
			: {}),
		...(anchor?.hasAttribute("download") || el.hasAttribute("download") ? { download: true } : {}),
		...(control.disabled || el.getAttribute("aria-disabled") === "true" ? { disabled: true } : {}),
		...(anchor ? { href: anchor.getAttribute("href") ?? undefined } : {}),
		...(type !== "password" && "value" in control && typeof control.value === "string"
			? { value: control.value.slice(0, 500) }
			: {}),
	};
}

/** A hung page never answers: the title is then empty rather than a hang. */
async function safeTitle(page: Page): Promise<string> {
	return Promise.race([page.title().catch(() => ""), sleep(2_000).then(() => "")]);
}

/** Closing a page whose renderer is stuck can wait forever: give it a moment, then let go. */
async function closeQuickly(page: Page): Promise<void> {
	await Promise.race([page.close({ runBeforeUnload: false }).catch(() => {}), sleep(3_000)]);
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

function firstLine(err: unknown, max = 300): string {
	const text = err instanceof Error ? err.message : String(err);
	return clean(text.split("\n").find((l) => l.trim()) ?? text, max);
}

function findNode(nodes: AriaChild[], ref: string): AriaNode | undefined {
	for (const node of nodes) {
		if (typeof node === "string") continue;
		if (node.ref === ref) return node;
		const inner = node.children ? findNode(node.children, ref) : undefined;
		if (inner) return inner;
	}
	return undefined;
}

export class BrowserSession {
	private readonly options: SessionOptions;
	private context?: BrowserContext;
	private active?: Page;
	/** The pages this runtime opened for the task. Tabs it did not open are never used or touched. */
	private readonly taskPages = new Set<Page>();
	private idleTimer?: NodeJS.Timeout;
	private chooserOpened = false;
	private starting?: Promise<void>;
	private readonly navSeq = new WeakMap<Page, number>();
	private baseline?: Baseline;
	private downloadDir?: string;
	private downloads: Captured[] = [];
	private pendingDownloads = new Set<Promise<void>>();
	private downloadSeq = 0;
	private readonly contentTypes = new Map<string, string>();
	private notes: string[] = [];
	private openedDuringAct?: Page;
	private current?: { index: number; grantId?: string };
	/** A download that starts within this long of an action's end still belongs to it. */
	private currentUntil = 0;
	private acting = false;
	private readonly usedApprovals = new Set<string>();

	constructor(options: SessionOptions) {
		this.options = options;
	}

	// ---- lifecycle -------------------------------------------------------------------------

	/**
	 * Starts Chromium on first use, and again if the user closed the window. A task always works
	 * in a page of its own, opened blank in the persistent context: a page left on another site
	 * (by an earlier task or by the user) is never reused.
	 */
	private async ensure(): Promise<Page> {
		this.touch();
		if (!this.context) {
			this.starting ??= this.launch().finally(() => {
				this.starting = undefined;
			});
			await this.starting;
		}
		const context = this.context!;
		if (!this.active || this.active.isClosed()) {
			const open = [...this.taskPages].filter((p) => !p.isClosed());
			this.active = open.at(-1);
			if (!this.active) {
				this.active = await context.newPage();
				this.taskPages.add(this.active);
				this.baseline = undefined;
			}
		}
		return this.active;
	}

	private touch(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.endTask(), this.options.idleMs ?? DEFAULT_IDLE_MS);
		this.idleTimer.unref();
	}

	/** Closes the task's pages (the profile and its logins stay). The next call opens a fresh blank page. */
	async endTask(): Promise<{ closed: number }> {
		clearTimeout(this.idleTimer);
		const pages = [...this.taskPages];
		this.taskPages.clear();
		this.active = undefined;
		this.baseline = undefined;
		this.notes = [];
		await Promise.all(pages.map((p) => closeQuickly(p)));
		return { closed: pages.length };
	}

	private async launch(): Promise<void> {
		const { headless, profileDir } = this.options;
		if (!headless && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			throw new ToolError(
				"The browser is set to show a window, but this computer has no display. Start the runtime with --headless."
			);
		}
		this.downloadDir ??= await mkdtemp(join(tmpdir(), "cerea-browser-"));
		let context: BrowserContext;
		try {
			context = await chromium.launchPersistentContext(profileDir, {
				headless,
				acceptDownloads: true,
				viewport: headless ? (this.options.viewport ?? { width: 1280, height: 800 }) : null,
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				chromiumSandbox: !this.options.noSandbox,
				args: [
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-background-networking",
					"--disable-component-update",
				],
			});
		} catch (err) {
			const message = firstLine(err, 600);
			if (/ProcessSingleton|profile.*in use|SingletonLock|user data directory is already in use/i.test(message)) {
				throw new ToolError(
					`The browser profile ${profileDir} is already open in another browser. Close it, or stop the other runtime that uses it.`
				);
			}
			if (/Executable doesn't exist|playwright install/i.test(message)) {
				throw new ToolError(
					"The browser is not installed for this runtime. Run `galopin browser setup` on the computer."
				);
			}
			if (/sandbox/i.test(message) && !this.options.noSandbox) {
				throw new ToolError(
					"Chromium's sandbox does not work on this computer. Run `galopin browser setup` again to check, or start the runtime with --no-sandbox."
				);
			}
			throw new ToolError(`The browser could not start: ${message}`);
		}
		context.setDefaultTimeout(ACTION_TIMEOUT_MS);
		context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
		// A page cannot take the browser to a local file or an internal page; only http(s) and blank.
		await context.route(
			(url) => !/^(https?|about|blob|data|ws|wss):$/.test(url.protocol),
			(route) => route.abort("blockedbyclient")
		);
		context.on("page", (page) => this.hook(page, true));
		for (const page of context.pages()) this.hook(page, false);
		context.on("response", (response) => {
			const type = response.headers()["content-type"];
			if (!type) return;
			if (this.contentTypes.size > 200) this.contentTypes.clear();
			this.contentTypes.set(response.url(), type.split(";")[0].trim().toLowerCase());
		});
		context.on("close", () => {
			if (this.context === context) {
				this.context = undefined;
				this.active = undefined;
				this.baseline = undefined;
				this.taskPages.clear();
			}
		});
		this.context = context;
	}

	private hook(page: Page, isNew: boolean): void {
		this.navSeq.set(page, 0);
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) this.navSeq.set(page, (this.navSeq.get(page) ?? 0) + 1);
		});
		page.on("dialog", (dialog) => {
			if (this.notes.length < 5) {
				this.notes.push(`a ${dialog.type()} dialog was dismissed: ${clean(dialog.message(), 120)}`);
			}
			void dialog.dismiss().catch(() => {});
		});
		page.on("filechooser", () => {
			// Nothing is chosen: the chooser is dropped and the action is reported as failed.
			this.chooserOpened = true;
		});
		page.on("popup", (popup) => {
			if (this.taskPages.has(page)) this.taskPages.add(popup);
		});
		page.on("download", (download) => {
			const work = this.capture(download).catch((e) => { if (process.env.CEREA_DEBUG) console.error("capture failed", e); });
			this.pendingDownloads.add(work);
			void work.finally(() => this.pendingDownloads.delete(work));
		});
		page.on("close", () => {
			this.taskPages.delete(page);
			if (this.active === page) this.active = undefined;
		});
		if (isNew && this.acting && this.taskPages.has(this.active!)) {
			this.openedDuringAct = page;
			this.taskPages.add(page);
		}
	}

	private async capture(download: Download): Promise<void> {
		const name = safeFileName(download.suggestedFilename());
		const dir = this.downloadDir!;
		const path = join(dir, `${(this.downloadSeq += 1)}-${name}`);
		const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
		const mime =
			this.contentTypes.get(download.url()) ??
			MIME_BY_EXTENSION[extension] ??
			"application/octet-stream";
		// Provenance is read now: the event fires while the action that caused it is running.
		const origin = this.current && (this.acting || Date.now() < this.currentUntil) ? { actionIndex: this.current.index, grantId: this.current.grantId } : {};
		const failure = await download.failure();
		if (failure) {
			this.downloads.push({ name, mime, size: 0, skipped: `the download failed: ${clean(failure, 100)}`, ...origin });
			return;
		}
		await download.saveAs(path);
		const size = (await stat(path)).size;
		if (this.downloads.length >= MAX_DOWNLOADS) {
			await rm(path, { force: true });
			this.downloads.push({ name, mime, size, skipped: "too many files captured at once", ...origin });
			return;
		}
		if (size > MAX_DOWNLOAD_BYTES) {
			await rm(path, { force: true });
			this.downloads.push({ name, mime, size, skipped: `larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`, ...origin });
			return;
		}
		this.downloads.push({ name, mime, size, path, ...origin });
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		this.taskPages.clear();
		const context = this.context;
		this.context = undefined;
		this.active = undefined;
		await context?.close().catch(() => {});
		if (this.downloadDir) await rm(this.downloadDir, { recursive: true, force: true }).catch(() => {});
		this.downloadDir = undefined;
	}

	/** Extension point for phase 2: run something against the active page (a CDP session, say). */
	async withPage<T>(fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
		const page = await this.ensure();
		return fn(page, this.context!);
	}

	// ---- snapshot --------------------------------------------------------------------------

	private async model(page: Page): Promise<AriaNode[]> {
		try {
			const json = await page.ariaSnapshotJSON({ mode: "ai", boxes: true, timeout: 10_000 });
			return json as unknown as AriaNode[];
		} catch (err) {
			throw new ToolError(`The page could not be read: ${firstLine(err)}`);
		}
	}

	private async fetchMeta(page: Page, refs: string[]): Promise<Map<string, DomMeta>> {
		const meta = new Map<string, DomMeta>();
		let next = 0;
		const worker = async () => {
			while (next < refs.length) {
				const ref = refs[next++];
				try {
					meta.set(ref, await page.getByRef(ref).evaluate(pageMeta, undefined, { timeout: META_TIMEOUT_MS }));
				} catch {
					// Gone or detached between the snapshot and now: it has no metadata.
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(12, refs.length) }, worker));
		return meta;
	}

	private async build(page: Page): Promise<Built> {
		const url = page.url();
		const title = clean(await safeTitle(page), 300);
		const roots = await this.model(page);
		const { children, collapsed } = collapse(roots);
		const max = this.options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;

		// Lay out without metadata to learn which controls survive the size cut, fetch their facts,
		// then lay out again with them.
		const first = fit(layout(children, { currentUrl: url, meta: new Map() }), max);
		const refs = first.lines.flatMap((l) => l.controls.map((c) => c.ref!));
		const meta = await this.fetchMeta(page, refs);
		const ctx = { currentUrl: url, meta };
		const fitted = fit(layout(children, ctx), max);

		const entries = new Map<string, Entry>();
		const textLines: string[] = [];
		for (const line of fitted.lines) {
			if (line.controls.length > 0) {
				for (const node of line.controls) {
					entries.set(node.ref!, { line: line.text, element: toElement(node, ctx) });
				}
			} else if (line.text.startsWith("text ")) {
				textLines.push(line.text);
			}
		}
		const tabs = [...this.taskPages].filter((p) => !p.isClosed()).length || 1;
		const header = [`url: ${url}`, `title: ${JSON.stringify(title)}`, ...(tabs > 1 ? [`tabs: ${tabs}`] : [])];
		const snapshot: Snapshot = {
			url,
			title,
			text: render(fitted, header),
			elements: [...entries.values()].map((e) => e.element),
			...(collapsed > 0 ? { collapsed } : {}),
		};
		return { snapshot, entries, textLines };
	}

	async snapshot(): Promise<Snapshot> {
		const page = await this.ensure();
		const built = await this.build(page);
		this.baseline = {
			page,
			seq: this.navSeq.get(page) ?? 0,
			url: page.url(),
			entries: built.entries,
			textLines: built.textLines,
		};
		return built.snapshot;
	}

	async diff(): Promise<Diff> {
		const page = await this.ensure();
		const before = this.baseline;
		if (!before || before.page !== page || before.seq !== (this.navSeq.get(page) ?? 0) || before.url !== page.url()) {
			const snapshot = await this.snapshot();
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
		const now = await this.build(page);
		const added: SnapshotElement[] = [];
		const changed: SnapshotElement[] = [];
		const removed: string[] = [];
		const lines: string[] = [];
		for (const [ref, entry] of now.entries) {
			const old = before.entries.get(ref);
			if (!old) {
				added.push(entry.element);
				lines.push(`+ ${entry.line}`);
			} else if (old.line !== entry.line) {
				changed.push(entry.element);
				lines.push(`~ ${entry.line}`);
			}
		}
		for (const ref of before.entries.keys()) {
			if (!now.entries.has(ref)) {
				removed.push(ref);
				lines.push(`- [${ref}]`);
			}
		}
		const counts = new Map<string, number>();
		for (const t of before.textLines) counts.set(t, (counts.get(t) ?? 0) + 1);
		const addedText: string[] = [];
		for (const t of now.textLines) {
			const n = counts.get(t) ?? 0;
			if (n > 0) counts.set(t, n - 1);
			else addedText.push(t);
		}
		const removedText = [...counts].flatMap(([t, n]) => Array.from({ length: n }, () => t));
		for (const t of addedText.slice(0, 20)) lines.push(`+ ${t}`);
		for (const t of removedText.slice(0, 20)) lines.push(`- ${t}`);
		const more = addedText.length + removedText.length - Math.min(addedText.length, 20) - Math.min(removedText.length, 20);
		if (more > 0) lines.push(`… and ${more} more text changes`);
		this.baseline = { ...before, entries: now.entries, textLines: now.textLines };
		const { url, title } = now.snapshot;
		return {
			url,
			title,
			navigated: false,
			added,
			changed,
			removed,
			text: [`<page-content untrusted="true">`, `url: ${url} (same page)`, `title: ${JSON.stringify(title)}`, ...(lines.length > 0 ? lines : ["(no change)"]), `</page-content>`].join("\n"),
		};
	}

	// ---- act -------------------------------------------------------------------------------

	/** The element a ref names right now, as Cerea would have it in its snapshot. */
	private async lookup(page: Page, ref: string): Promise<SnapshotElement> {
		const node = findNode(await this.model(page), ref);
		if (!node) {
			throw new ToolError(
				`No element with ref ${ref} on this page. Refs reset when the page navigates: take a new snapshot.`
			);
		}
		const meta = await this.fetchMeta(page, [ref]);
		return toElement(node, { currentUrl: page.url(), meta });
	}

	async act(actions: BrowserAction[], approvals: ApprovalGrant[] | undefined): Promise<ActResult> {
		const page0 = await this.ensure();
		const results: ActionResult[] = [];
		const downloadsBefore = this.downloads.length;
		this.notes = [];
		this.chooserOpened = false;
		this.acting = true;
		this.openedDuringAct = undefined;
		try {
			for (let index = 0; index < actions.length; index += 1) {
				const action = actions[index];
				const page = this.active && !this.active.isClosed() ? this.active : await this.ensure();
				let result = await this.withBudget(this.runOne(page, action, index, approvals));
				if (result.ok && this.chooserOpened) {
					this.chooserOpened = false;
					result = { ok: false, error: "The page asked for a file to upload. File choosers are not supported; nothing was chosen." };
				}
				results.push(result);
				if (!result.ok) break;
			}
		} finally {
			this.acting = false;
			await Promise.race([Promise.allSettled([...this.pendingDownloads]), sleep(15_000)]);
			this.currentUntil = Date.now() + 1000;
		}
		// A page that no longer answers (a script stuck in a loop) is dropped: the next call opens a fresh one.
		const live = this.active;
		if (live && !live.isClosed() && results.some((x) => !x.ok && !x.refused)) {
			const answered = await Promise.race([live.evaluate(() => 1).then(() => true, () => true), sleep(2_000).then(() => false)]);
			if (!answered) {
				this.taskPages.delete(live);
				this.active = undefined;
				this.baseline = undefined;
				void closeQuickly(live);
				const last = results.at(-1)!;
				last.error = clean(`${last.error ?? "failed"}; the page stopped responding and was closed`, 1000);
			}
		}
		const opened = this.takeOpened();
		if (opened && !opened.isClosed()) {
			this.active = opened;
			await opened.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
		}
		const page = this.active && !this.active.isClosed() ? this.active : page0;
		const last = results.at(-1);
		if (last && this.notes.length > 0) {
			const said = this.notes.join("; ");
			if (last.ok) last.outcome = clean(`${last.outcome ?? "done"}; ${said}`, 300);
			else last.error = clean(`${last.error ?? "failed"}; ${said}`, 1000);
		}
		// Each file says which action of this batch made it and the grant it ran under: Cerea keeps
		// only files an approved download action produced.
		const downloads = this.downloads
			.slice(downloadsBefore)
			.flatMap((d) =>
				d.actionIndex === undefined
					? []
					: [{ name: d.name, mime: d.mime, actionIndex: d.actionIndex, ...(d.grantId ? { grantId: d.grantId } : {}) }]
			);
		return {
			results,
			url: page.url(),
			title: clean(await safeTitle(page), 300),
			...(downloads.length > 0 ? { downloads } : {}),
		};
	}

	/** An action never hangs the batch: past the budget it fails and `act` returns. */
	private withBudget(work: Promise<ActionResult>): Promise<ActionResult> {
		let timer: NodeJS.Timeout;
		const timeout = new Promise<ActionResult>((ok) => {
			timer = setTimeout(
				() => ok({ ok: false, error: "The action did not finish in time (30 s). The page may be stuck." }),
				ACTION_BUDGET_MS
			);
		});
		return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
	}

	private async runOne(
		page: Page,
		action: BrowserAction,
		index: number,
		approvals: ApprovalGrant[] | undefined
	): Promise<ActionResult> {
		try {
			// What the action touches, read from the page now, not from an earlier snapshot.
			let element: SnapshotElement | undefined;
			const ref = "ref" in action ? action.ref : undefined;
			if (ref) element = await this.lookup(page, ref);
			const ctx: ClassifyContext = { element, currentUrl: page.url() };

			if (action.type === "navigate") {
				const target = (() => {
					try {
						return new URL(action.url, page.url());
					} catch {
						return undefined;
					}
				})();
				const ok = target && (target.protocol === "http:" || target.protocol === "https:" || target.href === "about:blank");
				if (!ok) {
					return {
						ok: false,
						refused: "scheme_refused",
						error: "Only http and https addresses can be opened (about:blank too), whatever the approval.",
					};
				}
			}

			// A link whose target is not a web address is refused whatever the grant.
			if (action.type === "click" && element?.href) {
				const target = (() => {
					try {
						return new URL(element.href, page.url());
					} catch {
						return undefined;
					}
				})();
				if (target && target.protocol !== "http:" && target.protocol !== "https:" && target.href !== "about:blank") {
					return { ok: false, refused: "scheme_refused", error: "That link does not lead to a web address, and is never opened." };
				}
			}
			const klass = classifyAction(action, ctx).class;
			const grant = approvals?.find((g) => g.index === index);
			if (klass === "commit") {
				const refusal = this.checkApproval(action, ctx, grant);
				if (refusal) return refusal;
			}
			this.current = { index, grantId: grant?.id };
			const before = page.url();
			let outcome = await this.perform(page, action);
			if (action.type !== "navigate" && page.url() !== before && !page.isClosed()) {
				outcome = clean(`${outcome}; the page navigated to ${clean(page.url(), 150)}`, 300);
			}
			if (klass === "commit") this.consume(grant);
			return { ok: true, outcome };
		} catch (err) {
			return { ok: false, error: err instanceof ToolError ? err.message : firstLine(err) };
		}
	}

	/**
	 * The runtime's half of ADR 0116 §4: a commit runs only with a grant that Cerea signed, that has
	 * not expired and that was issued for exactly this action as the page is now.
	 */
	private checkApproval(
		action: BrowserAction,
		ctx: ClassifyContext,
		grant: ApprovalGrant | undefined
	): ActionResult | undefined {
		if (!grant) {
			return {
				ok: false,
				refused: "approval_required",
				error: "This action needs the user's approval first (it submits, spends, sends, deletes or leaves the site).",
			};
		}
		const key = readKey({ keyFile: this.options.keyFile });
		const verdict: GrantCheck = checkGrant(grant, actionDigest(action, ctx), key);
		if (verdict === "no_key") {
			return {
				ok: false,
				refused: "approval_required",
				error: "This runtime has no approval key, so it cannot accept approvals. Run `galopin browser enable` again.",
			};
		}
		if (verdict === "expired") {
			return { ok: false, refused: "approval_expired", error: "The approval has expired. Ask again." };
		}
		if (verdict !== "ok") {
			const why =
				verdict === "bad_signature"
					? "The approval's signature is not valid."
					: "The approval does not match this action as the page is now (the page or the control changed).";
			return { ok: false, refused: "approval_mismatch", error: why };
		}
		// A user's approval is for one action. A site rule (`site:` ids) is a standing grant.
		if (!grant.id.startsWith("site:") && this.usedApprovals.has(grant.id)) {
			return { ok: false, refused: "approval_mismatch", error: "This approval was already used for an earlier action." };
		}
		return undefined;
	}

	private consume(grant: ApprovalGrant | undefined): void {
		if (!grant || grant.id.startsWith("site:")) return;
		if (this.usedApprovals.size > 1000) this.usedApprovals.clear();
		this.usedApprovals.add(grant.id);
	}

	private takeOpened(): Page | undefined {
		const page = this.openedDuringAct;
		this.openedDuringAct = undefined;
		return page;
	}

	private async settle(page: Page): Promise<void> {
		await page.waitForLoadState("load", { timeout: 4_000 }).catch(() => {});
		await sleep(120);
	}

	private target(page: Page, ref: string): Locator {
		return page.getByRef(ref);
	}

	private async perform(page: Page, action: BrowserAction): Promise<string> {
		switch (action.type) {
			case "click": {
				await this.target(page, action.ref).click({ timeout: ACTION_TIMEOUT_MS });
				await sleep(150);
				await this.settle(page);
				return this.openedDuringAct ? "clicked (opened a new tab, now on it)" : "clicked";
			}
			case "fill": {
				const locator = this.target(page, action.ref);
				await locator.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
				// A field can run script on input; the page may have moved on.
				await sleep(100);
				if (action.submit) {
					await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
					await this.settle(page);
					return `typed ${action.text.length} characters and pressed Enter`;
				}
				await this.settle(page);
				return `typed ${action.text.length} characters`;
			}
			case "select": {
				const chosen = await this.target(page, action.ref).selectOption(action.value, { timeout: ACTION_TIMEOUT_MS });
				if (chosen.length === 0) throw new ToolError(`No option "${clean(action.value, 60)}" in that list.`);
				return `chose ${clean(action.value, 60)}`;
			}
			case "press": {
				if (action.ref) await this.target(page, action.ref).press(playwrightKey(action.key), { timeout: ACTION_TIMEOUT_MS });
				else await page.keyboard.press(playwrightKey(action.key));
				await sleep(100);
				await this.settle(page);
				return `pressed ${clean(action.key, 32)}`;
			}
			case "scroll": {
				const direction = action.direction === "up" ? -1 : 1;
				const screens = action.amount ?? 1;
				const position = await page.evaluate(
					({ direction: d, screens: n }) => {
						const before = window.scrollY;
						window.scrollBy({ top: d * n * window.innerHeight * 0.8, behavior: "instant" });
						const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
						return { moved: window.scrollY !== before, percent: Math.round((window.scrollY / max) * 100) };
					},
					{ direction, screens }
				);
				await sleep(150);
				return position.moved
					? `scrolled ${action.direction} (now ${position.percent}% down the page)`
					: `already at the ${action.direction === "up" ? "top" : "bottom"} of the page`;
			}
			case "wait_for": {
				const budget = action.ms ?? 10_000;
				if (action.text) {
					try {
						await page.getByText(action.text).first().waitFor({ state: "visible", timeout: budget });
					} catch {
						throw new ToolError(`The text "${clean(action.text, 60)}" did not appear within ${budget} ms.`);
					}
					return "text appeared";
				}
				if (action.ms) {
					await sleep(action.ms);
					return `waited ${action.ms} ms`;
				}
				await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
				return "waited for the page to settle";
			}
			case "navigate": {
				const target = new URL(action.url, page.url()).href;
				try {
					const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
					await this.settle(page);
					const status = response?.status();
					return status && status >= 400 ? `navigated (the site answered HTTP ${status})` : "navigated";
				} catch (err) {
					if (/Download is starting/i.test(String(err))) return "navigation started a download";
					throw new ToolError(`Could not load ${clean(target, 120)}: ${firstLine(err, 160)}`);
				}
			}
		}
	}

	// ---- extract, screenshot, download -----------------------------------------------------

	async extract(request: { ref?: string; mode?: ExtractOptions["mode"] }): Promise<ExtractResult> {
		const page = await this.ensure();
		const mode = request.mode ?? "auto";
		const options: ExtractOptions = { mode, maxRows: 500, maxItems: 200, maxText: 20_000 };
		const args = { ...options, whole: !request.ref };
		let raw: RawExtract;
		try {
			if (request.ref) {
				raw = await page.getByRef(request.ref).evaluate(pageExtract, args, { timeout: 3_000 });
			} else {
				raw = await page.locator("body").evaluate(pageExtract, args, { timeout: 5_000 });
			}
		} catch (err) {
			if (/Timeout/.test(String(err))) {
				throw new ToolError(
					request.ref
						? `No element with ref ${request.ref} on this page. Refs reset when the page navigates: take a new snapshot.`
						: "The page could not be read."
				);
			}
			throw new ToolError(`The page could not be read: ${firstLine(err)}`);
		}
		return shapeExtract(raw, options, request.ref !== undefined || mode === "text");
	}

	async screenshot(request: { ref?: string; format?: "png" | "jpeg" }): Promise<{ mime: string; base64: string }> {
		const page = await this.ensure();
		const type = request.format === "jpeg" ? "jpeg" : "png";
		try {
			const buffer = request.ref
				? await page.getByRef(request.ref).screenshot({ type, timeout: 5_000, ...(type === "jpeg" ? { quality: 70 } : {}) })
				: await page.screenshot({ type, ...(type === "jpeg" ? { quality: 70 } : {}), timeout: 8_000 });
			return { mime: `image/${type}`, base64: buffer.toString("base64") };
		} catch (err) {
			if (request.ref && /Timeout/.test(String(err))) {
				throw new ToolError(
					`No element with ref ${request.ref} on this page. Refs reset when the page navigates: take a new snapshot.`
				);
			}
			throw new ToolError(`The screenshot failed: ${firstLine(err)}`);
		}
	}

	/**
	 * Files captured since the last call. Only files that an `act` action produced come back
	 * (they carry the action's index and the grant id that covered it); a file the page started on
	 * its own stays here unless `all` is set. Cerea decides what to do with the rest.
	 */
	async download(request: { all?: boolean } = {}): Promise<DownloadResult> {
		await Promise.race([Promise.allSettled([...this.pendingDownloads]), sleep(15_000)]);
		const give = this.downloads.filter((d) => request.all || d.actionIndex !== undefined);
		this.downloads = this.downloads.filter((d) => !give.includes(d));
		const files: DownloadResult["files"] = [];
		for (const file of give.slice(0, MAX_DOWNLOADS)) {
			const origin = {
				...(file.actionIndex !== undefined ? { actionIndex: file.actionIndex } : {}),
				...(file.grantId ? { grantId: file.grantId } : {}),
			};
			if (file.skipped || !file.path) {
				files.push({ name: file.name, mime: file.mime, size: file.size, skipped: file.skipped ?? "not captured", ...origin });
				continue;
			}
			// The size was checked when the file was saved, before anything is read or encoded.
			if (file.size > MAX_DOWNLOAD_BYTES) {
				files.push({ name: file.name, mime: file.mime, size: file.size, skipped: `larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`, ...origin });
			} else {
				const bytes = await readFile(file.path);
				files.push({ name: file.name, mime: file.mime, size: bytes.byteLength, base64: bytes.toString("base64"), ...origin });
			}
			await rm(file.path, { force: true });
		}
		return { files };
	}
}
