/**
 * RSS, Atom and RDF feeds as a compact list, and feed discovery on pages.
 *
 * A feed is 90 KB of XML to read a hundred headlines from. The model needs the
 * title, date, link and a line of summary of each item, nothing else.
 */

import { parseDocument } from "htmlparser2";
import { readablePageText } from "./readable";

export const MAX_FEED_ITEMS = 100;
const SUMMARY_CHARS = 200;

interface XmlNode {
	type: string;
	name?: string;
	data?: string;
	children?: XmlNode[];
	attribs?: Record<string, string>;
}

const EMPTY: XmlNode = { type: "text", data: "" };
const local = (name: string | undefined) => (name ?? "").toLowerCase().replace(/^.*:/, "");

function textOf(node: XmlNode): string {
	if (node.type === "text") return node.data ?? "";
	return (node.children ?? []).map(textOf).join("");
}

function elementChildren(node: XmlNode): XmlNode[] {
	return (node.children ?? []).filter((c) => c.type === "tag");
}

function child(node: XmlNode, ...names: string[]): XmlNode | undefined {
	return elementChildren(node).find((c) => names.includes(local(c.name)));
}

function plain(raw: string): string {
	return readablePageText(raw).trim();
}

/** The link of an RSS item (text) or of an Atom entry (`href`, preferring rel=alternate). */
function linkOf(node: XmlNode): string {
	const links = elementChildren(node).filter((c) => local(c.name) === "link");
	const pick = links.find((l) => !l.attribs?.rel || l.attribs.rel === "alternate") ?? links[0];
	if (!pick) return "";
	return (pick.attribs?.href ?? textOf(pick)).trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The compact list for a feed document, or null when the text is not a feed
 * (or is not well-formed enough to read), so the caller carries on as before.
 */
export function parseFeed(xml: string): { title: string | null; text: string } | null {
	if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 2_000))) return null;
	let doc: XmlNode;
	try {
		doc = parseDocument(xml, { xmlMode: true }) as unknown as XmlNode;
	} catch {
		return null;
	}
	const root = elementChildren(doc).find((c) => ["rss", "feed", "rdf"].includes(local(c.name)));
	if (!root) return null;
	const kind = local(root.name);
	const channel =
		kind === "rss" ? child(root, "channel") : kind === "rdf" ? child(root, "channel") : root;
	if (!channel) return null;
	// RSS and Atom keep items inside the channel/feed; RDF keeps them beside it.
	const holder = kind === "rss" ? channel : root;
	const items = elementChildren(holder).filter((c) => ["item", "entry"].includes(local(c.name)));
	if (items.length === 0) return null;

	const title = plain(textOf(child(channel, "title") ?? EMPTY)) || null;
	const feedLink = linkOf(channel);
	const lines = items.slice(0, MAX_FEED_ITEMS).map((item) => {
		const date = textOf(child(item, "pubdate", "published", "updated", "date") ?? EMPTY).trim();
		const itemTitle = plain(textOf(child(item, "title") ?? EMPTY)) || "Untitled";
		const summaryNode = child(item, "description", "summary", "encoded", "content");
		const summary = summaryNode ? clip(plain(textOf(summaryNode)), SUMMARY_CHARS) : "";
		const parts = [date, itemTitle, linkOf(item)].filter(Boolean);
		return `- ${parts.join(" — ")}${summary ? ` — ${summary}` : ""}`;
	});
	const total = items.length;
	const count = total > MAX_FEED_ITEMS ? `${MAX_FEED_ITEMS} of ${total} items` : `${total} items`;
	const header = `Feed: ${title ?? "Untitled"}${feedLink ? ` (${feedLink})` : ""} — ${count}`;
	return { title, text: `${header}\n${lines.join("\n")}` };
}

/** Whether a response may be a feed, from its content type; XML types are confirmed by `parseFeed`. */
export function mayBeFeed(contentType: string): boolean {
	const type = contentType.split(";")[0].trim().toLowerCase();
	return (
		type === "application/rss+xml" ||
		type === "application/atom+xml" ||
		type === "application/rdf+xml" ||
		type === "application/xml" ||
		type === "text/xml"
	);
}

/** Absolute URLs of the feeds an HTML page advertises in its head (at most `max`). */
export function discoverFeeds(html: string, baseUrl: string, max = 3): string[] {
	const head =
		/<head\b[\s\S]*?<\/head>/i.exec(html.slice(0, 500_000))?.[0] ?? html.slice(0, 20_000);
	const found: string[] = [];
	for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
		const get = (name: string) => {
			const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
			return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
		};
		if (!/\balternate\b/i.test(get("rel"))) continue;
		if (!/^application\/(?:rss|atom)\+xml\b/i.test(get("type").trim())) continue;
		const href = get("href").replace(/&amp;/g, "&").trim();
		if (!href) continue;
		try {
			const abs = new URL(href, baseUrl);
			if (abs.protocol !== "https:" && abs.protocol !== "http:") continue;
			if (!found.includes(abs.href)) found.push(abs.href);
		} catch {
			// skip an unparseable href
		}
		if (found.length >= max) break;
	}
	return found;
}
