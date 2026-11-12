/**
 * From Playwright's AI aria snapshot (as JSON) to the pruned snapshot the model reads.
 *
 * Pipeline: `collapse` folds repeated rows and items; `layout` renders the tree to lines (with
 * the metadata the classifier needs attached to each line that carries a ref); `fit` cuts the
 * lines to a size budget, dropping what is above the viewport first so that scrolling reveals
 * more. Nothing here talks to a browser: the DOM facts (form membership, submit, download) come in
 * as `DomMeta`, fetched by the session for the lines that survive.
 */

import type { SnapshotElement } from "./contract.ts";
import { siteOf } from "./classifier.ts";
import { CONTENT_TAG, clean, quote } from "./sanitize.ts";

export interface AriaNode {
	role: string;
	name?: string;
	text?: string;
	ref?: string;
	url?: string;
	level?: number;
	checked?: boolean | "mixed";
	disabled?: boolean;
	selected?: boolean;
	expanded?: boolean;
	pressed?: boolean | "mixed";
	invalid?: boolean;
	cursor?: string;
	placeholder?: string;
	box?: { x: number; y: number; width: number; height: number };
	children?: AriaChild[];
}
export type AriaChild = AriaNode | string;

/** What only the DOM knows about an element. */
export interface DomMeta {
	inputType?: string;
	form?: string;
	formMethod?: "get" | "post";
	submits?: boolean;
	/** The host the form would send its data to (its action URL, resolved). */
	formActionHost?: string;
	download?: boolean;
	disabled?: boolean;
	/** The raw `href` attribute of a link. */
	href?: string;
	/** A field's value, never a password's. */
	value?: string;
}

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"tab",
	"switch",
	"slider",
	"spinbutton",
	"treeitem",
]);
const FIELD_ROLES: ReadonlySet<string> = new Set([
	"textbox",
	"searchbox",
	"spinbutton",
	"combobox",
	"listbox",
	"slider",
]);
const INLINE_ROLES: ReadonlySet<string> = new Set([
	"strong",
	"emphasis",
	"code",
	"mark",
	"time",
	"subscript",
	"superscript",
	"deletion",
	"insertion",
	"text",
]);
/** Containers that get a line of their own and indent their children. */
const FENCED_ROLES: ReadonlySet<string> = new Set([
	"form",
	"dialog",
	"alertdialog",
	"alert",
	"status",
	"search",
	"navigation",
	"main",
	"region",
	"table",
	"grid",
	"toolbar",
	"menu",
	"tablist",
	"list",
	"group",
	"article",
]);
/** Fenced roles shown only when they carry a name. */
const NAMED_ONLY: ReadonlySet<string> = new Set([
	"main",
	"region",
	"list",
	"group",
	"toolbar",
	"menu",
	"tablist",
	"article",
	"table",
	"grid",
]);
const CELL_ROLES: ReadonlySet<string> = new Set(["cell", "gridcell", "columnheader", "rowheader"]);

/** Rows kept before the rest fold into one line; more when a row holds something to click. */
export const KEEP_ROWS = 3;
export const KEEP_ROWS_WITH_CONTROLS = 10;
const TEXT_MAX = 240;
const NAME_MAX = 200;

// ---- interactive-ness ----------------------------------------------------------------------

const interactiveCache = new WeakMap<AriaNode, boolean>();

export function isInteractive(node: AriaNode): boolean {
	return Boolean(node.ref) && (INTERACTIVE_ROLES.has(node.role) || node.cursor === "pointer");
}

/** Whether the node or something under it is something to act on. */
export function hasInteractive(node: AriaChild): boolean {
	if (typeof node === "string") return false;
	const cached = interactiveCache.get(node);
	if (cached !== undefined) return cached;
	let found = isInteractive(node);
	if (!found && node.children) found = node.children.some(hasInteractive);
	interactiveCache.set(node, found);
	return found;
}

// ---- text and names ------------------------------------------------------------------------

/** The text under a node, joined with single spaces. */
export function nodeText(node: AriaChild): string {
	if (typeof node === "string") return node;
	if (node.text !== undefined) return node.text;
	if (node.children) {
		return node.children
			.map(nodeText)
			.filter((part) => part.length > 0)
			.join(" ");
	}
	return node.name ?? "";
}

/**
 * The name Cerea classifies by. It is the accessible name, plus the visible text when the two
 * differ: `<button aria-label="Show details">Pay €120</button>` is named for both, so a verb
 * hidden behind a label is still seen.
 */
export function effectiveName(node: AriaNode): string {
	const name = clean(node.name ?? "", NAME_MAX);
	if (FIELD_ROLES.has(node.role)) return name;
	const visible = clean(nodeText(node), NAME_MAX);
	if (!name) return visible;
	if (!visible || name.toLowerCase().includes(visible.toLowerCase())) return name;
	if (visible.toLowerCase().includes(name.toLowerCase())) return visible;
	return clean(`${name} / ${visible}`, NAME_MAX * 2);
}

// ---- collapsing ----------------------------------------------------------------------------

export interface CollapsedMarker extends AriaNode {
	role: "#collapsed";
	text: string;
}

function isHeaderRow(node: AriaNode): boolean {
	const cells = (node.children ?? []).filter((c): c is AriaNode => typeof c !== "string");
	return cells.length > 0 && cells.every((c) => c.role === "columnheader");
}

function isCollapsible(child: AriaChild): child is AriaNode {
	return (
		typeof child !== "string" &&
		(child.role === "row" || child.role === "listitem") &&
		!(child.role === "row" && isHeaderRow(child))
	);
}

/**
 * Folds runs of repeated rows and list items after the first few into one line that points at
 * `extract`. Returns the new children and how many nodes were folded away.
 */
export function collapse(children: AriaChild[]): { children: AriaChild[]; collapsed: number } {
	let collapsed = 0;
	const walk = (list: AriaChild[]): AriaChild[] => {
		const out: AriaChild[] = [];
		let i = 0;
		while (i < list.length) {
			const child = list[i];
			if (!isCollapsible(child)) {
				out.push(typeof child === "string" ? child : recurse(child));
				i += 1;
				continue;
			}
			let j = i;
			while (j < list.length) {
				const next = list[j];
				if (!isCollapsible(next) || next.role !== child.role) break;
				j += 1;
			}
			const run = list.slice(i, j) as AriaNode[];
			const keep = run.some(hasInteractive) ? KEEP_ROWS_WITH_CONTROLS : KEEP_ROWS;
			if (run.length > keep + 2) {
				for (const row of run.slice(0, keep)) out.push(recurse(row));
				const folded = run.length - keep;
				collapsed += folded;
				const what = child.role === "row" ? "rows" : "items";
				out.push({
					role: "#collapsed",
					text: `… and ${folded} more ${what} like this; use extract to read them all`,
					box: run[keep]?.box,
				} satisfies CollapsedMarker);
			} else {
				for (const row of run) out.push(recurse(row));
			}
			i = j;
		}
		return out;
	};
	const recurse = (node: AriaNode): AriaNode =>
		node.children ? { ...node, children: walk(node.children) } : node;
	return { children: walk(children), collapsed };
}

// ---- layout --------------------------------------------------------------------------------

export interface Line {
	depth: number;
	text: string;
	/** The node's top and bottom edge in viewport coordinates, when it has a box. */
	top?: number;
	bottom?: number;
	/** The controls this line carries (one for an item line, several for a row of links). */
	controls: AriaNode[];
}

export interface LayoutContext {
	currentUrl: string;
	meta: ReadonlyMap<string, DomMeta>;
}

function relativeOrAbsolute(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const trimmed = clean(url, 300);
	return trimmed || undefined;
}

/** A link target leaves the page's site when it resolves to another registrable domain. */
export function linkDomainOf(href: string | undefined, currentUrl: string): string | undefined {
	if (!href) return undefined;
	try {
		const target = new URL(href, currentUrl);
		if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
		const current = new URL(currentUrl).hostname;
		if (siteOf(target.hostname) === siteOf(current)) return undefined;
		return target.hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

const flag = (node: AriaNode, key: "checked" | "selected" | "expanded" | "pressed"): string => {
	const v = node[key];
	if (v === undefined || v === false) return key === "checked" ? " unchecked" : "";
	return v === "mixed" ? ` ${key}=mixed` : ` ${key}`;
};

/** The element Cerea classifies by, for a node the model can act on. */
export function toElement(node: AriaNode, ctx: LayoutContext): SnapshotElement {
	const meta = ctx.meta.get(node.ref ?? "") ?? {};
	const href = relativeOrAbsolute(node.url ?? meta.href);
	const linkDomain = node.role === "link" ? linkDomainOf(href, ctx.currentUrl) : undefined;
	const password = meta.inputType === "password";
	let value: string | undefined;
	if (FIELD_ROLES.has(node.role) && !password) {
		if (node.role === "combobox" || node.role === "listbox") {
			const selected = optionsOf(node).find((o) => o.selected);
			value = clean(selected?.name ?? meta.value ?? node.text ?? "", 500) || undefined;
		} else {
			value = clean(node.text ?? meta.value ?? "", 500) || undefined;
		}
	}
	const disabled = node.disabled === true || meta.disabled === true;
	const element: SnapshotElement = {
		ref: node.ref ?? "",
		role: node.role,
		name: effectiveName(node),
		...(meta.inputType ? { inputType: meta.inputType } : {}),
		...(meta.form ? { form: meta.form } : {}),
		...(meta.formMethod ? { formMethod: meta.formMethod } : {}),
		...(meta.submits ? { submits: true } : {}),
		...(meta.formActionHost ? { formActionHost: meta.formActionHost } : {}),
		...(href && node.role === "link" ? { href } : {}),
		...(linkDomain ? { linkDomain } : {}),
		...(meta.download || (node.role === "link" && looksLikeFile(href)) ? { download: true } : {}),
		...(disabled ? { disabled: true } : {}),
		...(value ? { value } : {}),
	};
	return element;
}

const FILE_EXTENSIONS =
	/\.(pdf|zip|csv|xlsx?|docx?|pptx?|tar|gz|tgz|7z|rar|exe|dmg|pkg|msi|apk|iso|bin)$/i;

export function looksLikeFile(href: string | undefined): boolean {
	if (!href) return false;
	try {
		return FILE_EXTENSIONS.test(new URL(href, "http://x").pathname);
	} catch {
		return false;
	}
}

function optionsOf(node: AriaNode): Array<{ name: string; selected: boolean }> {
	return (node.children ?? [])
		.filter((c): c is AriaNode => typeof c !== "string" && c.role === "option")
		.map((o) => ({ name: clean(o.name ?? nodeText(o), 80), selected: o.selected === true }));
}

/** One line for something the model can act on. */
export function itemToken(node: AriaNode, ctx: LayoutContext): string {
	const el = toElement(node, ctx);
	const meta = ctx.meta.get(node.ref ?? "") ?? {};
	let out = `[${node.ref}] ${node.role}`;
	if (el.name) out += ` ${quote(el.name)}`;
	switch (node.role) {
		case "link":
			if (el.href) out += ` → ${el.href}`;
			break;
		case "textbox":
		case "searchbox":
		case "spinbutton":
			if (el.inputType && el.inputType !== "text") out += ` type=${el.inputType}`;
			if (el.value) out += ` value=${quote(el.value)}`;
			else if (node.placeholder) out += ` placeholder=${quote(clean(node.placeholder, 80))}`;
			break;
		case "combobox":
		case "listbox": {
			const options = optionsOf(node);
			if (el.value) out += ` value=${quote(el.value)}`;
			if (options.length > 0) {
				const shown = options.slice(0, 12).map((o) => quote(o.name));
				out += ` options: ${shown.join(" | ")}${options.length > 12 ? ` | …+${options.length - 12}` : ""}`;
			}
			break;
		}
		case "checkbox":
		case "radio":
		case "switch":
			out += flag(node, "checked");
			break;
		case "tab":
		case "menuitem":
		case "treeitem":
		case "menuitemcheckbox":
		case "menuitemradio":
			out += flag(node, "selected") + flag(node, "expanded");
			break;
		case "button":
			out += flag(node, "pressed") + flag(node, "expanded");
			if (meta.submits) out += " (submits form)";
			break;
	}
	if (el.disabled) out += " (disabled)";
	if (el.download) out += " (download)";
	if (el.linkDomain) out += ` (other site: ${el.linkDomain})`;
	return out;
}

/** Renders the (collapsed) tree to lines. */
export function layout(nodes: AriaChild[], ctx: LayoutContext): Line[] {
	const lines: Line[] = [];
	let inherited: { top?: number; bottom?: number } = {};

	const push = (depth: number, text: string, node?: AriaNode, controls: AriaNode[] = []) => {
		const box = node?.box;
		const top = box ? box.y : inherited.top;
		const bottom = box ? box.y + box.height : inherited.bottom;
		lines.push({ depth, text, top, bottom, controls });
	};

	const walk = (children: AriaChild[], depth: number) => {
		let buffer: string[] = [];
		const flush = () => {
			const text = clean(buffer.join(" ").replace(/\s+([.,;:!?])/g, "$1"), TEXT_MAX);
			buffer = [];
			if (text) push(depth, `text ${quote(text)}`);
		};
		for (const child of children) {
			if (typeof child === "string") {
				buffer.push(child);
				continue;
			}
			if (INLINE_ROLES.has(child.role) && !hasInteractive(child)) {
				buffer.push(nodeText(child));
				continue;
			}
			flush();
			visit(child, depth);
		}
		flush();
	};

	const visit = (node: AriaNode, depth: number) => {
		const saved = inherited;
		if (node.box) inherited = { top: node.box.y, bottom: node.box.y + node.box.height };
		try {
			visitInner(node, depth);
		} finally {
			inherited = saved;
		}
	};

	const visitInner = (node: AriaNode, depth: number) => {
		if (node.role === "#collapsed") return push(depth, quoteMarker(node.text ?? ""), node);
		if (isInteractive(node)) return push(depth, itemToken(node, ctx), node, [node]);
		if (node.role === "heading") {
			const text = clean(node.name ?? nodeText(node), TEXT_MAX);
			if (hasInteractive(node) && !node.name) return walk(node.children ?? [], depth);
			if (text) push(depth, `${"#".repeat(Math.min(node.level ?? 1, 6))} ${text}`, node);
			return;
		}
		if (node.role === "row") return renderRow(node, depth);
		if (node.role === "img") {
			const alt = clean(node.name ?? "", 120);
			if (alt) push(depth, `image ${quote(alt)}`, node);
			return;
		}
		if (FENCED_ROLES.has(node.role)) {
			const name = clean(node.name ?? "", 120);
			if (name || !NAMED_ONLY.has(node.role)) {
				push(depth, `${node.role}${name ? ` ${quote(name)}` : ""}`, node);
				return walkContent(node, depth + 1);
			}
			return walkContent(node, depth);
		}
		return walkContent(node, depth);
	};

	const walkContent = (node: AriaNode, depth: number) => {
		if (node.children && node.children.length > 0) return walk(node.children, depth);
		const text = clean(node.text ?? node.name ?? "", TEXT_MAX);
		if (text) push(depth, `text ${quote(text)}`, node);
	};

	const renderRow = (row: AriaNode, depth: number) => {
		const cells = (row.children ?? []).filter((c): c is AriaNode => typeof c !== "string");
		if (cells.length === 0 || !cells.every((c) => CELL_ROLES.has(c.role))) {
			return walkContent(row, depth);
		}
		const header = isHeaderRow(row);
		const controls: AriaNode[] = [];
		const parts = cells.map((cell) => cellContent(cell, controls));
		push(depth, `${header ? "header" : "row"}: ${parts.join(" | ")}`, row, controls);
	};

	const cellContent = (cell: AriaNode, controls: AriaNode[]): string => {
		const parts: string[] = [];
		const gather = (child: AriaChild) => {
			if (typeof child === "string") return parts.push(clean(child, TEXT_MAX));
			if (isInteractive(child)) {
				controls.push(child);
				return parts.push(itemToken(child, ctx));
			}
			if (child.children && hasInteractive(child)) return child.children.forEach(gather);
			parts.push(clean(nodeText(child), TEXT_MAX));
		};
		if (cell.children && hasInteractive(cell)) cell.children.forEach(gather);
		else parts.push(clean(cell.text ?? cell.name ?? nodeText(cell), TEXT_MAX));
		return parts.filter(Boolean).join(" ");
	};

	walk(nodes, 0);
	return lines;
}

const quoteMarker = (text: string) => `text ${quote(text)}`;

// ---- fitting -------------------------------------------------------------------------------

export interface Fitted {
	lines: Line[];
	above: number;
	below: number;
	/** Text lines of the hint at the top and bottom, when something was cut. */
	topHint?: string;
	bottomHint?: string;
}

const lineSize = (line: Line) => line.depth * 2 + line.text.length + 1;

/**
 * Cuts lines to `maxChars`. What lies wholly above the viewport goes first (scrolling up brings
 * it back), then the end of the page goes.
 */
export function fit(lines: Line[], maxChars: number): Fitted {
	let total = lines.reduce((sum, line) => sum + lineSize(line), 0);
	if (total <= maxChars) return { lines, above: 0, below: 0 };
	let kept = lines;
	let above = 0;
	if (lines.some((l) => l.bottom !== undefined && l.bottom < 0)) {
		kept = lines.filter((l) => !(l.bottom !== undefined && l.bottom < 0));
		above = lines.length - kept.length;
		total = kept.reduce((sum, line) => sum + lineSize(line), 0);
	}
	let below = 0;
	const budget = maxChars - 160;
	if (total > maxChars) {
		let used = 0;
		let end = 0;
		while (end < kept.length && used + lineSize(kept[end]) <= budget) {
			used += lineSize(kept[end]);
			end += 1;
		}
		below = kept.length - end;
		kept = kept.slice(0, end);
	}
	const topHint = above > 0 ? `… ${above} lines above the viewport (scroll up to see them)` : undefined;
	const bottomHint =
		below > 0
			? `… truncated: ${below} more lines below (scroll down to see them, or use extract for tables and lists)`
			: undefined;
	return { lines: kept, above, below, topHint, bottomHint };
}

export function render(fitted: Fitted, header: string[]): string {
	const body = fitted.lines.map((l) => `${"  ".repeat(l.depth)}${l.text}`);
	return [
		`<${CONTENT_TAG} untrusted="true">`,
		...header,
		...(fitted.topHint ? [`text ${quote(fitted.topHint)}`] : []),
		...body,
		...(fitted.bottomHint ? [`text ${quote(fitted.bottomHint)}`] : []),
		`</${CONTENT_TAG}>`,
	].join("\n");
}
