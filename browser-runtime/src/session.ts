/**
 * The browser: one persistent Chromium context, the tabs in it, and the six protocol operations.
 *
 * Calls are serialised by the caller (`server.ts`), so nothing here is re-entrant. Phase 2 (live
 * view, takeover) hooks in through `withPage`: a CDP session is opened from the active page, and
 * a takeover pauses the protocol operations by holding the same queue.
 */

import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	chromium,
	type BrowserContext,
	type Download,
	type Locator,
	type Page,
} from "playwright-core";
import {
	actionDigest,
	classifyAction,
	siteOf,
	urlWithoutFragment,
	type ClassifyContext,
} from "./classifier.ts";
import { randomBytes } from "node:crypto";
import { hostMatches, hostOf, parseSiteList } from "./siteRules.ts";
import { UsedGrants, checkGrant, readKey, type GrantCheck } from "./grants.ts";
import {
	MAX_DOWNLOAD_BYTES,
	type ActResult,
	type ActionResult,
	type ApprovalGrant,
	type BrowserAction,
	type Diff,
	type Challenge,
	type DownloadResult,
	type EndTaskResult,
	type ResumeResult,
	type Tab,
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
	/** Where spent approvals are remembered across restarts (default: beside the profile). */
	stateDir?: string;
	/** How long one action may run before the batch gives up on it (default 30 s). */
	actionBudgetMs?: number;
	/** Use an installed browser instead of the bundled Chromium: "chrome". */
	channel?: string;
	/** A small random pause between actions and between batches; off when absent. */
	pace?: { minMs: number; maxMs: number };
	/** How long a page kept at the end of a task can be resumed with its token (default 24 h). */
	keptTtlMs?: number;
}

export const DEFAULT_MAX_SNAPSHOT_CHARS = 9_000;
const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const META_TIMEOUT_MS = 1_500;
const MAX_DOWNLOADS = 20;
/** Files the page started on its own are kept back; only a few, so they never crowd out approved ones. */
const MAX_UNATTRIBUTED = 5;
/** A download that sends nothing for this long is abandoned. */
const DOWNLOAD_STALL_MS = 20_000;
const ACTION_BUDGET_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const KEPT_TTL_MS = 24 * 60 * 60_000;

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

/**
 * Runs inside the page: the facts about an element that only the DOM has. It runs in the page's
 * own world, so a hostile page can spoof its own answers; that only lets a page mislead the
 * runtime about itself (docs/browser-runtime.md, "What the runtime cannot know").
 */
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
	// A human-verification widget (reCAPTCHA, hCaptcha, Turnstile, an interstitial) is the user's to solve.
	const widget =
		!!el.closest(
			".g-recaptcha, #recaptcha, .h-captcha, .cf-turnstile, #cf-challenge-running, #challenge-form, #challenge-stage, [data-sitekey]"
		) ||
		(tag === "iframe" &&
			/google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com/i.test(
				el.getAttribute("src") ?? ""
			)) ||
		/(^|\.)(hcaptcha\.com|challenges\.cloudflare\.com|recaptcha\.net|arkoselabs\.com)$/.test(
			location.hostname
		) ||
		(/(^|\.)google\.com$/.test(location.hostname) && location.pathname.startsWith("/recaptcha"));
	return {
		...(widget ? { challenge: true } : {}),
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

/**
 * PROPOSED (contract): `resume` answers this instead of a ResumeResult when the kept page has been
 * moved since it was kept. Cerea then goes through `use_tab` (with approval) or starts afresh.
 */
export interface ResumeRefused {
	refused: "page_changed";
	title: string;
	url: string;
}

/** A user's tab shown without what a query string or fragment can carry (tokens, searches). */
export function stripUserUrl(url: string): string {
	try {
		const u = new URL(url);
		u.search = "";
		u.hash = "";
		u.username = "";
		u.password = "";
		return u.href;
	} catch {
		return "";
	}
}

/** A hung page never answers: the title is then empty rather than a hang. */
async function safeTitle(page: Page): Promise<string> {
	return Promise.race([page.title().catch(() => ""), sleep(2_000).then(() => "")]);
}

/** Closing a page whose renderer is stuck can wait forever: give it a moment, then let go. */
async function closeQuickly(page: Page): Promise<void> {
	await Promise.race([page.close({ runBeforeUnload: false }).catch(() => {}), sleep(3_000)]);
}

/**
 * Runs inside the page: the kind of human-verification step on it, if any. Known widgets are found
 * by their frames and markers; interstitials by their title or their short, telling text.
 */
function focusInChallenge(): boolean {
	const el = document.activeElement;
	if (!el || el === document.body) {
		return /(^|\.)(hcaptcha\.com|challenges\.cloudflare\.com|recaptcha\.net|arkoselabs\.com)$/.test(
			location.hostname
		);
	}
	return (
		!!el.closest(
			".g-recaptcha, #recaptcha, .h-captcha, .cf-turnstile, #cf-challenge-running, #challenge-form, #challenge-stage, [data-sitekey]"
		) ||
		(el.tagName === "IFRAME" &&
			/google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com/i.test(
				el.getAttribute("src") ?? ""
			))
	);
}

function pageChallenge(): string | undefined {
	const frames = Array.from(document.querySelectorAll("iframe"))
		.filter((f) => !f.closest(".grecaptcha-badge"))
		.map((f) => (f.getAttribute("src") ?? "").toLowerCase());
	const any = (re: RegExp) => frames.some((src) => re.test(src));
	if (
		any(/google\.com\/recaptcha|recaptcha\.net/) ||
		document.querySelector(".g-recaptcha, #recaptcha")
	)
		return "recaptcha";
	if (any(/hcaptcha\.com/) || document.querySelector(".h-captcha")) return "hcaptcha";
	if (any(/challenges\.cloudflare\.com/) || document.querySelector(".cf-turnstile"))
		return "turnstile";
	if (any(/arkoselabs\.com|funcaptcha/)) return "arkose";
	if (
		document.querySelector("#cf-challenge-running, #challenge-form, #challenge-stage") ||
		/^just a moment/i.test(document.title) ||
		/attention required.*cloudflare/i.test(document.title)
	)
		return "cloudflare";
	const text = (document.body?.innerText ?? "").slice(0, 2000);
	if (
		text.length < 1500 &&
		/(verify|confirm) (that )?you(?:'re| are) (a )?(human|not a robot)|are you a robot|unusual traffic from your computer|let us know you.re not a robot|press (&|and) hold to confirm|i.m not a robot/i.test(
			text
		)
	)
		return "human-check";
	return undefined;
}

const tooLarge = () => `larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`;

/** Download folders of runtimes that died without cleaning up (`cerea-browser-<pid>-...`). */
async function removeStaleDirs(): Promise<void> {
	try {
		for (const name of await readdir(tmpdir())) {
			const m = /^cerea-browser-(\d+)-/.exec(name);
			if (!m) continue;
			const pid = Number(m[1]);
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (err) {
				alive = (err as NodeJS.ErrnoException).code === "EPERM";
			}
			if (!alive) await rm(join(tmpdir(), name), { recursive: true, force: true });
		}
	} catch {
		// Best effort.
	}
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
	/**
	 * The host of the last real (http/https) site this task's pages were on, mirroring Cerea's
	 * classifier context: a page with no host (`about:blank`) is judged against it, and while it is
	 * unset the task has not left its blank start page yet (its first navigation).
	 */
	private taskLastSite: string | undefined;
	private baseline?: Baseline;
	private downloadDir?: string;
	private downloads: Captured[] = [];
	private pendingDownloads = new Set<Promise<void>>();
	private downloadSeq = 0;
	private readonly contentTypes = new Map<string, { type: string; length?: number }>();
	private notes: string[] = [];
	private openedDuringAct?: Page;
	private current?: {
		index: number;
		grantId?: string;
		/** Only a download action (or a navigation) can own a file, and only the first one. */
		eligible: boolean;
		/** The address the clicked link points at: a file must come from there. */
		href?: string;
		claimed: boolean;
	};
	private queue: Promise<unknown> = Promise.resolve();
	/** Task pages that are the user's own tabs, adopted with a grant: released, never closed. */
	private readonly adopted = new Set<Page>();
	private readonly tabIds = new WeakMap<Page, string>();
	private tabSeq = 0;
	private lastActEnd = 0;
	private tabDeny: string[] = [];
	/** Pages kept open at the end of a task, by the token that resumes them. */
	private readonly kept = new Map<
		string,
		{ page: Page; expires: number; url: string; title: string }
	>();
	private foreignTabs: string[] = [];
	private popups: Page[] = [];
	/** A download that starts within this long of an action's end still belongs to it. */
	private currentUntil = 0;
	private acting = false;
	private readonly used: UsedGrants;

	constructor(options: SessionOptions) {
		this.options = options;
		this.used = new UsedGrants(
			join(options.stateDir ?? dirname(options.profileDir), "used-grants.json")
		);
	}

	/**
	 * One queue for the whole session, however many connections or HTTP requests reach it: calls
	 * never overlap, so an approval cannot be spent twice by two calls racing.
	 */
	serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => {});
		return run;
	}

	// ---- lifecycle -------------------------------------------------------------------------

	/**
	 * Starts Chromium on first use, and again if the user closed the window. A task always works
	 * in a page of its own, opened blank in the persistent context: a page left on another site
	 * (by an earlier task or by the user) is never reused.
	 */
	private async ensureContext(): Promise<BrowserContext> {
		if (!this.context) {
			this.starting ??= this.launch().finally(() => {
				this.starting = undefined;
			});
			await this.starting;
		}
		return this.context!;
	}

	private async ensure(): Promise<Page> {
		this.touch();
		const context = await this.ensureContext();
		if (!this.active || this.active.isClosed()) {
			const open = [...this.taskPages].filter((p) => !p.isClosed());
			this.active = open.at(-1);
			if (!this.active) {
				this.active = await context.newPage();
				this.taskPages.add(this.active);
				this.baseline = undefined;
				this.taskLastSite = undefined;
			}
		}
		return this.active;
	}

	private touch(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.endTask(), this.options.idleMs ?? DEFAULT_IDLE_MS);
		this.idleTimer.unref();
	}

	/**
	 * Closes the task's pages (the profile and its logins stay). The next call opens a fresh blank
	 * page. With `keep`, the active page is not closed but released and given a token: the next
	 * task can `resume` it with that token, and without it the page is just a user tab. A tab the
	 * user lent to the task is let go, never closed.
	 */
	async endTask(
		options: { keep?: boolean } = {}
	): Promise<{ closed: number; kept?: NonNullable<EndTaskResult["kept"]> }> {
		clearTimeout(this.idleTimer);
		const pages = [...this.taskPages];
		const keep = options.keep ? this.active : undefined;
		let kept: EndTaskResult["kept"];
		// A tab the user lent is released, never kept: only a page the task opened can be.
		if (keep && !keep.isClosed() && this.taskPages.has(keep) && !this.adopted.has(keep)) {
			this.purgeKept();
			const token = randomBytes(18).toString("base64url");
			const title = clean(await safeTitle(keep), 300);
			const url = keep.url();
			this.kept.set(token, {
				page: keep,
				url,
				title,
				expires: Date.now() + (this.options.keptTtlMs ?? KEPT_TTL_MS),
			});
			kept = { token, id: this.tabId(keep), title, url: clean(url, 2000) };
		}
		this.taskPages.clear();
		this.active = undefined;
		this.baseline = undefined;
		this.notes = [];
		// A tab the user opened and lent to the task, and the page being kept, are let go.
		const own = pages.filter((p) => !this.adopted.has(p) && p !== (kept ? keep : undefined));
		this.adopted.clear();
		await Promise.all(own.map((p) => closeQuickly(p)));
		return { closed: own.length, ...(kept ? { kept } : {}) };
	}

	/** Forgets kept pages whose token has expired or whose page is gone (they stay open if open). */
	private purgeKept(): void {
		const now = Date.now();
		for (const [token, entry] of this.kept) {
			if (entry.expires <= now || entry.page.isClosed()) this.kept.delete(token);
		}
	}

	/**
	 * Makes a page kept by an earlier task the active page again, with no grant: the token is the
	 * proof that it was the task's own. Without it the page counts as a user tab (`use_tab`).
	 */
	async resume(token: string): Promise<ResumeResult | ResumeRefused> {
		await this.ensureContext();
		this.purgeKept();
		const entry = this.kept.get(token);
		if (!entry) {
			throw new ToolError(
				"That token does not name a kept page (it expired, was used, or the page was closed)."
			);
		}
		// The token is spent either way: a refused page is just one of the user's tabs from now on.
		this.kept.delete(token);
		const page = entry.page;
		const url = page.url();
		const title = clean(await safeTitle(page), 300);
		if (urlWithoutFragment(url) !== urlWithoutFragment(entry.url)) {
			// Someone moved it since: it is no longer the page the task left, so it is not the task's
			// to take back without asking (use_tab) or starting afresh.
			return { refused: "page_changed", title, url: clean(stripUserUrl(url), 2000) };
		}
		this.taskPages.add(page);
		this.active = page;
		this.baseline = undefined;
		this.touch();
		try {
			this.taskLastSite = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			this.taskLastSite = undefined;
		}
		const moved = title !== entry.title;
		return {
			id: this.tabId(page),
			title,
			url: clean(url, 2000),
			changed: moved,
			...(moved ? { was: { title: entry.title, url: clean(entry.url, 2000) } } : {}),
		};
	}

	private tabId(page: Page): string {
		let id = this.tabIds.get(page);
		if (!id) {
			id = `t${(this.tabSeq += 1)}`;
			this.tabIds.set(page, id);
		}
		return id;
	}

	/** The open pages of the persistent context, task pages and the user's own. */
	async tabs(options: { deny?: string[] } = {}): Promise<{ tabs: Tab[] }> {
		await this.ensureContext();
		this.touch();
		// The sites Cerea keeps the agent out of (its deny list): remembered, so use_tab refuses them too.
		if (options.deny) this.tabDeny = parseSiteList(options.deny.join("\n"));
		const pages = this.context!.pages().filter((p) => !p.isClosed());
		const tabs: Tab[] = [];
		for (const page of pages.slice(0, 50)) {
			const mine = this.taskPages.has(page);
			if (!mine && this.denied(page.url())) {
				tabs.push({ id: this.tabId(page), title: "a page on a denied site", url: "", mine: false });
				continue;
			}
			tabs.push({
				id: this.tabId(page),
				title: clean(await safeTitle(page), 300),
				// The task's own pages show in full; a user's tab never shows its query or fragment.
				url: clean(mine ? page.url() : stripUserUrl(page.url()), 2000),
				mine,
			});
		}
		return { tabs };
	}

	private denied(url: string): boolean {
		const host = hostOf(url);
		return !!host && this.tabDeny.some((entry) => hostMatches(host, entry));
	}

	private async launch(): Promise<void> {
		const { headless, profileDir } = this.options;
		if (
			!headless &&
			process.platform === "linux" &&
			!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY
		) {
			throw new ToolError(
				"The browser is set to show a window, but this computer has no display. Start the runtime with --headless."
			);
		}
		await removeStaleDirs();
		await chmod(profileDir, 0o700).catch(() => {});
		this.downloadDir ??= await mkdtemp(join(tmpdir(), `cerea-browser-${process.pid}-`));
		let context: BrowserContext;
		try {
			context = await chromium.launchPersistentContext(profileDir, {
				headless,
				acceptDownloads: true,
				viewport: headless ? (this.options.viewport ?? { width: 1280, height: 800 }) : null,
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				...(this.options.channel ? { channel: this.options.channel } : {}),
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
			if (
				/ProcessSingleton|profile.*in use|SingletonLock|user data directory is already in use/i.test(
					message
				)
			) {
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
		context.on("page", (page) => {
			this.hook(page);
			void this.adopt(page);
		});
		for (const page of context.pages()) this.hook(page);
		context.on("response", (response) => {
			const headers = response.headers();
			const type = headers["content-type"];
			if (!type) return;
			if (this.contentTypes.size > 200) this.contentTypes.clear();
			const length = Number(headers["content-length"]);
			this.contentTypes.set(response.url(), {
				type: type.split(";")[0].trim().toLowerCase(),
				...(Number.isFinite(length) ? { length } : {}),
			});
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

	private hook(page: Page): void {
		this.navSeq.set(page, 0);
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			this.navSeq.set(page, (this.navSeq.get(page) ?? 0) + 1);
			if (this.taskPages.has(page)) {
				try {
					const u = new URL(frame.url());
					if (u.protocol === "http:" || u.protocol === "https:") {
						this.taskLastSite = u.hostname.toLowerCase().replace(/\.$/, "");
					}
				} catch {
					// not a URL: nothing to remember
				}
			}
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
		page.on("download", (download) => {
			const work = this.capture(download).catch((e) => {
				if (process.env.CEREA_DEBUG) console.error("capture failed", e);
			});
			this.pendingDownloads.add(work);
			void work.finally(() => this.pendingDownloads.delete(work));
		});
		page.on("close", () => {
			this.taskPages.delete(page);
			if (this.active === page) this.active = undefined;
		});
	}

	/**
	 * A new page belongs to the task only if a task page opened it. A tab the user opened, or one
	 * that something else made, is never adopted, used or closed. A task page's popup is kept with
	 * the task so it closes with it, and offered to the running action as the next page.
	 */
	private async adopt(page: Page): Promise<void> {
		let opener: Page | null = null;
		try {
			opener = await page.opener();
		} catch {
			return;
		}
		if (!opener || !this.taskPages.has(opener)) return;
		this.taskPages.add(page);
		if (this.acting && opener === this.active) this.popups.push(page);
	}

	private async capture(download: Download): Promise<void> {
		const name = safeFileName(download.suggestedFilename());
		const dir = this.downloadDir!;
		const path = join(dir, `${(this.downloadSeq += 1)}-${name}`);
		const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
		// Playwright reports no response for a download, so its announced size and type are asked
		// of the server with a HEAD (same cookies, short timeout); a server that will not say is
		// held to the byte counter below.
		const seen = this.contentTypes.get(download.url()) ?? (await this.announced(download.url()));
		const mime = seen?.type ?? MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
		const origin = this.claim(download);
		const attributed = origin.actionIndex !== undefined;
		const note = (entry: Omit<Captured, "name" | "mime">) =>
			this.downloads.push({ name, mime, ...origin, ...entry });
		const room = this.downloads.filter((d) => (d.actionIndex !== undefined) === attributed).length;
		if (room >= (attributed ? MAX_DOWNLOADS : MAX_UNATTRIBUTED)) {
			// Past the cap a page's own files are dropped silently: they were never going to be handed on.
			if (attributed) note({ size: 0, skipped: "too many files captured at once" });
			void download.cancel().catch(() => {});
			return;
		}
		// The announced size is checked before a byte is fetched; the real size while it streams.
		if (seen?.length !== undefined && seen.length > MAX_DOWNLOAD_BYTES) {
			note({ size: seen.length, skipped: tooLarge() });
			void download.cancel().catch(() => {});
			return;
		}
		let bytes = 0;
		try {
			const readable = await download.createReadStream();
			if (!readable) {
				const failure = await download.failure();
				note({ size: 0, skipped: `the download failed: ${clean(failure ?? "no data", 100)}` });
				return;
			}
			const counter = new Transform({
				transform(chunk: Buffer, _enc, done) {
					bytes += chunk.length;
					done(bytes > MAX_DOWNLOAD_BYTES ? new Error("too large") : null, chunk);
				},
			});
			// A stream that stops sending is given up on, so a stalled server cannot hold the call.
			const stall = new AbortController();
			let timer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_MS);
			counter.on("data", () => {
				clearTimeout(timer);
				timer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_MS);
			});
			try {
				await pipeline(readable, counter, createWriteStream(path, { mode: 0o600 }), {
					signal: stall.signal,
				});
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			await rm(path, { force: true });
			if (bytes > MAX_DOWNLOAD_BYTES) {
				note({ size: bytes, skipped: tooLarge() });
				void download.cancel().catch(() => {});
			} else {
				note({ size: 0, skipped: `the download failed: ${firstLine(err, 100)}` });
			}
			void download.delete().catch(() => {});
			return;
		}
		// The browser's own copy is not needed any more.
		await download.delete().catch(() => {});
		note({ size: bytes, path });
	}

	private async announced(url: string): Promise<{ type: string; length?: number } | undefined> {
		if (!/^https?:/i.test(url) || !this.context) return undefined;
		try {
			const head = await this.context.request.head(url, {
				timeout: 3_000,
				failOnStatusCode: false,
			});
			const headers = head.headers();
			const length = Number(headers["content-length"]);
			const type = headers["content-type"]?.split(";")[0].trim().toLowerCase();
			await head.dispose();
			if (!type && !Number.isFinite(length)) return undefined;
			return {
				type: type ?? "application/octet-stream",
				...(Number.isFinite(length) ? { length } : {}),
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * The action a file belongs to, if any: only a download action (or a navigation) owns files, only
	 * the first, and a click's file must come from the link's own address. Everything else, a script
	 * or a timer or a second file, is unattributed.
	 */
	private claim(download: Download): { actionIndex?: number; grantId?: string } {
		const cur = this.current;
		if (!cur || !cur.eligible || cur.claimed) return {};
		if (!(this.acting || Date.now() < this.currentUntil)) return {};
		if (cur.href) {
			try {
				const want = new URL(cur.href).href;
				if (new URL(download.url()).href !== want) return {};
			} catch {
				return {};
			}
		}
		cur.claimed = true;
		return { actionIndex: cur.index, ...(cur.grantId ? { grantId: cur.grantId } : {}) };
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		this.taskPages.clear();
		const context = this.context;
		this.context = undefined;
		this.active = undefined;
		if (context) await Promise.race([context.close().catch(() => {}), sleep(5_000)]);
		if (this.downloadDir)
			await rm(this.downloadDir, { recursive: true, force: true }).catch(() => {});
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

	/** The DOM facts for each ref; a ref whose facts could not be read is in `failed`. */
	private async fetchMeta(
		page: Page,
		refs: string[]
	): Promise<{ meta: Map<string, DomMeta>; failed: Set<string> }> {
		const meta = new Map<string, DomMeta>();
		const failed = new Set<string>();
		let next = 0;
		const worker = async () => {
			while (next < refs.length) {
				const ref = refs[next++];
				try {
					meta.set(
						ref,
						await page.getByRef(ref).evaluate(pageMeta, undefined, { timeout: META_TIMEOUT_MS })
					);
				} catch {
					// Gone, detached or a busy page: its facts are unknown, and unknown fails closed.
					failed.add(ref);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(12, refs.length) }, worker));
		return { meta, failed };
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
		const { meta, failed } = await this.fetchMeta(page, refs);
		const ctx = { currentUrl: url, meta, unknown: failed };
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
		const header = [
			`url: ${url}`,
			`title: ${JSON.stringify(title)}`,
			...(tabs > 1 ? [`tabs: ${tabs}`] : []),
		];
		const challenge = await this.detectChallenge(page);
		if (challenge) {
			header.push(
				`challenge: ${challenge.kind} (a human-verification step: the user solves it; never click it)`
			);
		}
		const snapshot: Snapshot = {
			url,
			title,
			...(challenge ? { challenge } : {}),
			text: render(fitted, header),
			elements: [...entries.values()].map((e) => e.element),
			...(collapsed > 0 ? { collapsed } : {}),
		};
		return { snapshot, entries, textLines };
	}

	/** reCAPTCHA, hCaptcha, Turnstile, Arkose and the "verify you are human" interstitials. */
	private async detectChallenge(page: Page): Promise<Challenge | undefined> {
		try {
			const kind = await Promise.race([
				page.evaluate(pageChallenge),
				sleep(1_500).then(() => undefined),
			]);
			return kind ? { kind } : undefined;
		} catch {
			return undefined;
		}
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
		if (
			!before ||
			before.page !== page ||
			before.seq !== (this.navSeq.get(page) ?? 0) ||
			before.url !== page.url()
		) {
			const snapshot = await this.snapshot();
			return {
				url: snapshot.url,
				title: snapshot.title,
				...(snapshot.challenge ? { challenge: snapshot.challenge } : {}),
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
		const more =
			addedText.length +
			removedText.length -
			Math.min(addedText.length, 20) -
			Math.min(removedText.length, 20);
		if (more > 0) lines.push(`… and ${more} more text changes`);
		this.baseline = { ...before, entries: now.entries, textLines: now.textLines };
		const { url, title } = now.snapshot;
		const challenge = now.snapshot.challenge;
		return {
			url,
			title,
			...(challenge ? { challenge } : {}),
			navigated: false,
			added,
			changed,
			removed,
			text: [
				`<page-content untrusted="true">`,
				`url: ${url} (same page)`,
				`title: ${JSON.stringify(title)}`,
				...(lines.length > 0 ? lines : ["(no change)"]),
				`</page-content>`,
			].join("\n"),
		};
	}

	// ---- act -------------------------------------------------------------------------------

	/** The element a ref names right now, as Cerea would have it in its snapshot. */
	private async lookup(
		page: Page,
		ref: string
	): Promise<{ element: SnapshotElement; challenge: boolean }> {
		const node = findNode(await this.model(page), ref);
		if (!node) {
			throw new ToolError(
				`No element with ref ${ref} on this page. Refs reset when the page navigates: take a new snapshot.`
			);
		}
		const { meta, failed } = await this.fetchMeta(page, [ref]);
		return {
			element: toElement(node, { currentUrl: page.url(), meta, unknown: failed }),
			challenge: meta.get(ref)?.challenge === true,
		};
	}

	async act(actions: BrowserAction[], approvals: ApprovalGrant[] | undefined): Promise<ActResult> {
		const page0 = await this.ensure();
		const results: ActionResult[] = [];
		const downloadsBefore = this.downloads.length;
		this.notes = [];
		this.foreignTabs = [];
		this.popups = [];
		this.chooserOpened = false;
		this.acting = true;
		this.openedDuringAct = undefined;
		try {
			// A person does not fire a second batch the instant the first ends.
			if (this.lastActEnd > 0) await this.pause(Date.now() - this.lastActEnd);
			for (let index = 0; index < actions.length; index += 1) {
				const action = actions[index];
				if (index > 0) await this.pause(0);
				const page = this.active && !this.active.isClosed() ? this.active : await this.ensure();
				const budget = await this.withBudget(this.runOne(page, action, index, approvals));
				let result = budget.result;
				if (budget.timedOut) {
					// The action is still running in a page we no longer trust: drop the page, so
					// nothing it was doing can finish later or leak into the next call.
					this.taintPage(page);
					result = { ...result, error: `${result.error}; the page was closed` };
				}
				if (result.ok && this.chooserOpened) {
					this.chooserOpened = false;
					result = {
						ok: false,
						error:
							"The page asked for a file to upload. File choosers are not supported; nothing was chosen.",
					};
				}
				results.push(result);
				if (!result.ok) break;
			}
		} finally {
			this.acting = false;
			await Promise.race([Promise.allSettled([...this.pendingDownloads]), sleep(15_000)]);
			this.currentUntil = Date.now() + 1000;
			this.lastActEnd = Date.now();
		}
		// A page that no longer answers (a script stuck in a loop) is dropped: the next call opens a fresh one.
		const live = this.active;
		if (live && !live.isClosed() && results.some((x) => !x.ok && !x.refused)) {
			const answered = await Promise.race([
				live
					.evaluate(() => 1)
					.then(
						() => true,
						() => true
					),
				sleep(2_000).then(() => false),
			]);
			if (!answered) {
				this.taintPage(live);
				const last = results.at(-1)!;
				last.error = clean(
					`${last.error ?? "failed"}; the page stopped responding and was closed`,
					1000
				);
			}
		}
		await this.settlePopups();
		if (this.openedDuringAct) {
			const done = results.findLast((x) => x.ok);
			if (done) done.outcome = clean(`${done.outcome ?? "done"}; opened a new tab, now on it`, 300);
		}
		const page = this.active && !this.active.isClosed() ? this.active : page0;
		const last = results.at(-1);
		for (const host of this.foreignTabs) {
			this.notes.push(
				`a new tab opened on ${host}; it was not switched to (that would leave the site) and stays with the task`
			);
		}
		if (last && this.notes.length > 0) {
			const said = this.notes.join("; ");
			if (last.ok) last.outcome = clean(`${last.outcome ?? "done"}; ${said}`, 300);
			else last.error = clean(`${last.error ?? "failed"}; ${said}`, 1000);
		}
		// Each file says which action of this batch made it and the grant it ran under: Cerea keeps
		// only files an approved download action produced.
		const downloads = this.downloads.slice(downloadsBefore).flatMap((d) =>
			d.actionIndex === undefined
				? []
				: [
						{
							name: d.name,
							mime: d.mime,
							actionIndex: d.actionIndex,
							...(d.grantId ? { grantId: d.grantId } : {}),
						},
					]
		);
		return {
			results,
			url: page.url(),
			title: clean(await safeTitle(page), 300),
			...(downloads.length > 0 ? { downloads } : {}),
		};
	}

	/** A small random pause (when pacing is on), less what has already passed. */
	private async pause(elapsedMs: number): Promise<void> {
		const pace = this.options.pace;
		if (!pace || pace.maxMs <= 0) return;
		const wanted = pace.minMs + Math.random() * Math.max(0, pace.maxMs - pace.minMs);
		if (wanted > elapsedMs) await sleep(wanted - elapsedMs);
	}

	/** An action never hangs the batch: past the budget it fails and `act` returns. */
	private withBudget(
		work: Promise<ActionResult>
	): Promise<{ result: ActionResult; timedOut: boolean }> {
		let timer: NodeJS.Timeout;
		const timeout = new Promise<{ result: ActionResult; timedOut: boolean }>((ok) => {
			timer = setTimeout(
				() =>
					ok({
						result: {
							ok: false,
							error: "The action did not finish in time (30 s). The page may be stuck.",
						},
						timedOut: true,
					}),
				this.options.actionBudgetMs ?? ACTION_BUDGET_MS
			);
		});
		return Promise.race([work.then((result) => ({ result, timedOut: false })), timeout]).finally(
			() => clearTimeout(timer)
		);
	}

	private taintPage(page: Page): void {
		this.taskPages.delete(page);
		if (this.active === page) this.active = undefined;
		this.baseline = undefined;
		if (this.adopted.delete(page)) return;
		void closeQuickly(page);
	}

	private async runOne(
		page: Page,
		action: BrowserAction,
		index: number,
		approvals: ApprovalGrant[] | undefined
	): Promise<ActionResult> {
		try {
			if (action.type === "use_tab") return await this.useTab(action.tab, index, approvals);
			if (action.type === "press" && !action.ref) {
				// Keys go to whatever has focus: if that is a human-verification widget, it is the user's.
				const inside = await Promise.race([
					page.evaluate(focusInChallenge).catch(() => false),
					sleep(1_500).then(() => false),
				]);
				if (inside) {
					return {
						ok: false,
						refused: "challenge",
						error:
							"Focus is in a human-verification step (a CAPTCHA or bot check). The user has to solve it; keys are not sent there.",
					};
				}
			}
			// What the action touches, read from the page now, not from an earlier snapshot.
			let element: SnapshotElement | undefined;
			const ref = "ref" in action ? action.ref : undefined;
			if (ref) {
				const found = await this.lookup(page, ref);
				element = found.element;
				if (found.challenge) {
					// A human-verification widget is the user's to solve: no grant can cover it.
					return {
						ok: false,
						refused: "challenge",
						error:
							"That is a human-verification step (a CAPTCHA or bot check). The user has to solve it; it is never clicked or filled by the agent.",
					};
				}
			}
			const ctx: ClassifyContext = {
				element,
				currentUrl: page.url(),
				lastSite: this.taskLastSite,
				// Mirrors Cerea's "first navigation from the blank start page": the runtime knows only
				// that the task has not been on any site yet, which is the same moment.
				firstNavigation: this.taskLastSite === undefined,
			};

			if (action.type === "navigate") {
				const target = (() => {
					try {
						return new URL(action.url, page.url());
					} catch {
						return undefined;
					}
				})();
				const ok =
					target &&
					(target.protocol === "http:" ||
						target.protocol === "https:" ||
						target.href === "about:blank");
				if (!ok) {
					return {
						ok: false,
						refused: "scheme_refused",
						error:
							"Only http and https addresses can be opened (about:blank too), whatever the approval.",
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
				if (
					target &&
					target.protocol !== "http:" &&
					target.protocol !== "https:" &&
					target.href !== "about:blank"
				) {
					return {
						ok: false,
						refused: "scheme_refused",
						error: "That link does not lead to a web address, and is never opened.",
					};
				}
			}
			const classified = classifyAction(action, ctx);
			// An element whose facts could not be read is judged as a commit: unknown fails closed.
			const klass = element?.metaUnknown ? "commit" : classified.class;
			const grant = approvals?.find((g) => g.index === index);
			if (klass === "commit") {
				const refusal = this.checkApproval(actionDigest(action, ctx), grant);
				if (refusal) return refusal;
				// Spent before it runs: an approval that ran once (or half ran) is never run again.
				this.spend(grant!);
			}
			let href: string | undefined;
			if (action.type === "click" && element?.href) {
				try {
					href = new URL(element.href, page.url()).href;
				} catch {
					// No address to match: the file cannot be attributed.
				}
			}
			this.current = {
				index,
				grantId: grant?.id,
				eligible:
					action.type === "navigate" ||
					(klass === "commit" &&
						classified.class === "commit" &&
						classified.reason === "download" &&
						!(element?.href && !href)),
				href,
				claimed: false,
			};
			const before = page.url();
			let outcome = await this.perform(page, action);
			if (action.type !== "navigate" && page.url() !== before && !page.isClosed()) {
				outcome = clean(`${outcome}; the page navigated to ${clean(page.url(), 150)}`, 300);
			}
			return { ok: true, outcome };
		} catch (err) {
			return { ok: false, error: err instanceof ToolError ? err.message : firstLine(err) };
		}
	}

	/**
	 * Adopts a tab the user opened as the task's active page. It is always a commit (reason
	 * `user-tab`): it needs a signed grant bound to the tab's id, address and title as `tabs()` showed
	 * them. The tab is lent, not taken: ending the task releases it and never closes it.
	 */
	private async useTab(
		tabId: string,
		index: number,
		approvals: ApprovalGrant[] | undefined
	): Promise<ActionResult> {
		const context = await this.ensureContext();
		const page = context.pages().find((p) => !p.isClosed() && this.tabIds.get(p) === tabId);
		if (!page) {
			return { ok: false, error: `No open tab ${clean(tabId, 30)}. List them with tabs().` };
		}
		if (this.taskPages.has(page)) {
			return { ok: false, error: "That tab is already part of this task." };
		}
		if (this.denied(page.url())) {
			return { ok: false, error: "That tab is on a site the user's rules keep the agent out of." };
		}
		// The digest binds the tab as `tabs()` showed it: its address without query or fragment.
		const title = clean(await safeTitle(page), 300);
		const url = stripUserUrl(page.url());
		const grant = approvals?.find((g) => g.index === index);
		const refusal = this.checkApproval(
			actionDigest(
				{ type: "use_tab", tab: tabId },
				{ currentUrl: "", tab: { id: tabId, url, title } }
			),
			grant
		);
		if (refusal) return refusal;
		this.spend(grant!);
		this.purgeKept();
		for (const [token, entry] of this.kept) if (entry.page === page) this.kept.delete(token);
		this.taskPages.add(page);
		this.adopted.add(page);
		this.active = page;
		this.baseline = undefined;
		try {
			this.taskLastSite = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			this.taskLastSite = undefined;
		}
		return { ok: true, outcome: `now using the tab "${clean(title, 80)}"` };
	}

	/**
	 * The runtime's half of ADR 0116 §4: a commit runs only with a grant that Cerea signed, that has
	 * not expired and that was issued for exactly this action as the page is now.
	 */
	private checkApproval(
		digest: string,
		grant: ApprovalGrant | undefined
	): ActionResult | undefined {
		if (!grant) {
			return {
				ok: false,
				refused: "approval_required",
				error:
					"This action needs the user's approval first (it submits, spends, sends, deletes or leaves the site).",
			};
		}
		const key = readKey({ keyFile: this.options.keyFile });
		const verdict: GrantCheck = checkGrant(grant, digest, key);
		if (verdict === "no_key") {
			return {
				ok: false,
				refused: "approval_required",
				error:
					"This runtime has no approval key, so it cannot accept approvals. Run `galopin browser enable` again.",
			};
		}
		if (verdict === "exp_too_far") {
			return {
				ok: false,
				refused: "approval_mismatch",
				error:
					"The approval's expiry is too far ahead for this computer's clock: the clocks of Cerea and this computer disagree.",
			};
		}
		if (verdict === "expired") {
			return {
				ok: false,
				refused: "approval_expired",
				error: "The approval has expired. Ask again.",
			};
		}
		if (verdict !== "ok") {
			const why =
				verdict === "bad_signature"
					? "The approval's signature is not valid."
					: "The approval does not match this action as the page is now (the page or the control changed).";
			return { ok: false, refused: "approval_mismatch", error: why };
		}
		// A user's approval is for one action. A site rule (`site:` ids) is a standing grant.
		if (!grant.id.startsWith("site:") && this.used.has(grant.id)) {
			return {
				ok: false,
				refused: "approval_mismatch",
				error: "This approval was already used for an earlier action.",
			};
		}
		return undefined;
	}

	private spend(grant: ApprovalGrant): void {
		if (grant.id.startsWith("site:")) return;
		this.used.add(grant.id, grant.exp);
	}

	/**
	 * A page a task page opened becomes the active page when it is on the same site as its opener.
	 * One on another site is reported and left alone: moving the task there is a decision for the
	 * user, not for a page.
	 */
	private async settlePopups(): Promise<void> {
		const popups = this.popups;
		this.popups = [];
		const opener = this.active;
		for (const popup of popups) {
			if (popup.isClosed()) continue;
			await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
			let same = false;
			try {
				same =
					!!opener &&
					siteOf(new URL(popup.url()).hostname) === siteOf(new URL(opener.url()).hostname);
			} catch {
				same = popup.url() === "about:blank";
			}
			if (same && !this.openedDuringAct) {
				this.active = popup;
				this.openedDuringAct = popup;
			} else if (!same) {
				let host = popup.url();
				try {
					host = new URL(popup.url()).hostname;
				} catch {
					// Keep the raw address.
				}
				this.foreignTabs.push(clean(host, 100));
			}
		}
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
			case "use_tab":
				// Handled before anything else in runOne: it needs its own grant check.
				throw new ToolError("use_tab is not an action on a page.");
			case "click": {
				await this.target(page, action.ref).click({ timeout: ACTION_TIMEOUT_MS });
				await sleep(150);
				await this.settle(page);
				return "clicked";
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
				const chosen = await this.target(page, action.ref).selectOption(action.value, {
					timeout: ACTION_TIMEOUT_MS,
				});
				if (chosen.length === 0)
					throw new ToolError(`No option "${clean(action.value, 60)}" in that list.`);
				return `chose ${clean(action.value, 60)}`;
			}
			case "press": {
				if (action.ref)
					await this.target(page, action.ref).press(playwrightKey(action.key), {
						timeout: ACTION_TIMEOUT_MS,
					});
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
						return {
							moved: window.scrollY !== before,
							percent: Math.round((window.scrollY / max) * 100),
						};
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
						await page
							.getByText(action.text)
							.first()
							.waitFor({ state: "visible", timeout: budget });
					} catch {
						throw new ToolError(
							`The text "${clean(action.text, 60)}" did not appear within ${budget} ms.`
						);
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
					const response = await page.goto(target, {
						waitUntil: "domcontentloaded",
						timeout: NAVIGATION_TIMEOUT_MS,
					});
					await this.settle(page);
					const status = response?.status();
					return status && status >= 400
						? `navigated (the site answered HTTP ${status})`
						: "navigated";
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

	async screenshot(request: {
		ref?: string;
		format?: "png" | "jpeg";
	}): Promise<{ mime: string; base64: string }> {
		const page = await this.ensure();
		const type = request.format === "jpeg" ? "jpeg" : "png";
		try {
			const buffer = request.ref
				? await page
						.getByRef(request.ref)
						.screenshot({ type, timeout: 5_000, ...(type === "jpeg" ? { quality: 70 } : {}) })
				: await page.screenshot({
						type,
						...(type === "jpeg" ? { quality: 70 } : {}),
						timeout: 8_000,
					});
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
				files.push({
					name: file.name,
					mime: file.mime,
					size: file.size,
					skipped: file.skipped ?? "not captured",
					...origin,
				});
				continue;
			}
			// The size was checked when the file was saved, before anything is read or encoded.
			if (file.size > MAX_DOWNLOAD_BYTES) {
				files.push({
					name: file.name,
					mime: file.mime,
					size: file.size,
					skipped: `larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`,
					...origin,
				});
			} else {
				const bytes = await readFile(file.path);
				files.push({
					name: file.name,
					mime: file.mime,
					size: bytes.byteLength,
					base64: bytes.toString("base64"),
					...origin,
				});
			}
			await rm(file.path, { force: true });
		}
		return { files };
	}
}
