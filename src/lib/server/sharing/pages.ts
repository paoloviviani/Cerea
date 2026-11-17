import { randomBytes } from "node:crypto";
import { m } from "$lib/paraglide/messages";
import { escapeHTML } from "$lib/utils/markedLight";
import { processBlocksSync } from "$lib/utils/marked";
import { MAX_TABLE_RENDER_ROWS, parseCsvTable } from "$lib/utils/csv";
import { artifactFileName, type ArtifactKind } from "$lib/utils/artifacts";
import { buildArtifactSrcdoc } from "$lib/utils/previewSrcdoc";
import { buildSlidesSrcdoc } from "$lib/utils/slides/srcdoc";
import type { SharedArtifact } from "$lib/types/SharedArtifact";
import { config } from "$lib/server/config";

/** What the sandbox renders: running pages. Everything else is a read-only viewer. */
const SANDBOXED_KINDS: ReadonlySet<ArtifactKind> = new Set([
	"html",
	"svg",
	"react",
	"mermaid",
	"slides",
]);

export function isSandboxedShare(share: SharedArtifact): boolean {
	return share.snapshot.kind === "text" && SANDBOXED_KINDS.has(share.snapshot.type);
}

/** The headers every public response carries. No cookie is ever set. */
export function publicHeaders(extra: Record<string, string> = {}): Headers {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"X-Robots-Tag": "noindex, nofollow",
		...extra,
	});
	return headers;
}

/** The document a sandboxed artifact is, exactly as the panel's preview builds it. */
export function sandboxedDocument(share: SharedArtifact): string {
	const snapshot = share.snapshot;
	if (snapshot.kind !== "text") return "";
	// A channel makes the builders add the no-network policy as a meta tag; the
	// hook it also adds only posts link clicks to the page around the frame.
	if (snapshot.type === "slides") return buildSlidesSrcdoc(snapshot.content, "share");
	return buildArtifactSrcdoc(snapshot.type, snapshot.content, "share");
}

const PAGE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#111827}a{color:#93c5fd}}
.band{position:fixed;inset:0 0 auto 0;z-index:10;height:40px;display:flex;align-items:center;justify-content:center;padding:0 12px;background:#fef3c7;color:#78350f;border-bottom:1px solid #f59e0b;font:600 13px/1.2 system-ui,sans-serif;text-align:center}
.top{padding-top:40px;min-height:100%}
.frame{position:fixed;inset:40px 0 0 0;width:100%;height:calc(100% - 40px);border:0;background:#fff}
.linkbar{position:fixed;z-index:11;left:0;right:0;bottom:0;display:none;gap:12px;align-items:center;padding:10px 14px;background:#111827;color:#f9fafb;font:14px system-ui,sans-serif}
.linkbar.on{display:flex}.linkbar span{flex:1;overflow-wrap:anywhere}.linkbar a,.linkbar button{color:#111827;background:#fff;border:0;border-radius:6px;padding:6px 10px;font:inherit;text-decoration:none;cursor:pointer}
.nav{position:fixed;z-index:11;right:12px;bottom:12px;display:flex;gap:6px}.nav button{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:6px;padding:6px 10px;font:14px system-ui;cursor:pointer}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1.title{font-size:1.4rem;margin:0 0 4px}
.meta{color:#6b7280;font-size:.85rem;margin:0 0 20px}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:.9rem}
.doc pre{overflow:auto;padding:12px;border-radius:8px;background:#f3f4f6;color:#111827}
.doc table,.grid table{border-collapse:collapse;max-width:100%}
.doc th,.doc td,.grid th,.grid td{border:1px solid #d1d5db;padding:4px 8px;text-align:left;vertical-align:top}
.grid{overflow:auto;max-height:75vh}
.grid th{position:sticky;top:0;background:#f3f4f6;color:#111827}
.doc img{max-width:100%}
.note{color:#6b7280;font-size:.85rem;margin-top:8px}
`;

function shell(
	title: string,
	band: string,
	body: string,
	opts: { nonce?: string; locale?: string; script?: string; frameSrc?: boolean } = {}
): { html: string; csp: string } {
	const nonce = opts.nonce ?? randomBytes(12).toString("base64");
	const csp = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src data:",
		opts.script ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
		opts.frameSrc ? "frame-src 'self'" : "frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	const html = `<!doctype html>
<html lang="${escapeHTML(opts.locale ?? "en")}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>${escapeHTML(title)}</title><style>${PAGE_CSS}</style></head>
<body><div class="band" role="note">${escapeHTML(band)}</div>${body}${
		opts.script ? `<script nonce="${nonce}">${opts.script}</script>` : ""
	}</body></html>`;
	return { html, csp };
}

/** The deployment's address as users know it: the app origin's host, else the app name. */
function siteName(): string {
	const origin = (config.PUBLIC_ORIGIN ?? "").trim();
	try {
		return origin ? new URL(origin).host : "Cerea";
	} catch {
		return "Cerea";
	}
}

export function bandFor(share: SharedArtifact): string {
	return m["share.public.band"]({ site: siteName(), name: share.ownerName });
}

export function title(share: SharedArtifact): string {
	return share.snapshot.kind === "text" ? share.snapshot.title : share.snapshot.name;
}

/**
 * The page around a sandboxed artifact: a band the artifact cannot reach, and
 * the artifact itself in a frame loaded from a sibling URL, sandboxed by the
 * attribute here and, on its own response, by `Content-Security-Policy: sandbox`.
 */
export function wrapperPage(
	share: SharedArtifact,
	docPath: string,
	locale: string
): { html: string; csp: string } {
	const nonce = randomBytes(12).toString("base64");
	const isSlides = share.snapshot.kind === "text" && share.snapshot.type === "slides";
	const nav = isSlides
		? `<div class="nav"><button type="button" id="prev">${escapeHTML(m["share.public.prev"]())}</button><button type="button" id="next">${escapeHTML(m["share.public.next"]())}</button></div>`
		: "";
	const body = `<iframe class="frame" id="f" title="${escapeHTML(title(share))}" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="fullscreen" allowfullscreen src="${escapeHTML(docPath)}"></iframe>${nav}
<div class="linkbar" id="bar"><span id="msg"></span><a id="open" rel="noopener noreferrer nofollow" target="_blank" href="#">${escapeHTML(m["share.public.open_link"]())}</a><button type="button" id="close">${escapeHTML(m["share.public.dismiss"]())}</button></div>`;
	const script = `
(function(){
  var f=document.getElementById('f'),bar=document.getElementById('bar'),msg=document.getElementById('msg'),open=document.getElementById('open');
  var LINK=${JSON.stringify(m["share.public.links_to"]({ url: "%URL%" }))};
  window.addEventListener('message',function(e){
    if(e.source!==f.contentWindow)return;
    var d=e.data;if(!d||d.channel!=='share'||d.type!=='chatui.preview.openLink')return;
    var href=d.detail&&d.detail.href;if(typeof href!=='string'||!/^https?:\\/\\//i.test(href))return;
    msg.textContent=LINK.replace('%URL%',href);open.href=href;bar.className='linkbar on';
  });
  document.getElementById('close').addEventListener('click',function(){bar.className='linkbar'});
  function cmd(c){f.contentWindow.postMessage({type:'chatui.slides.cmd',channel:'share',detail:{cmd:c}},'*')}
  var p=document.getElementById('prev'),n=document.getElementById('next');
  if(p)p.addEventListener('click',function(){cmd('prev')});
  if(n)n.addEventListener('click',function(){cmd('next')});
})();`;
	return shell(title(share), bandFor(share), body, { nonce, script, frameSrc: true, locale });
}

function renderMarkdown(content: string): string {
	return processBlocksSync(content)
		.flatMap((block) => block.tokens)
		.map((token) => (token.type === "code" ? `<pre><code>${token.code}</code></pre>` : token.html))
		.join("\n");
}

function renderTable(content: string): string {
	const table = parseCsvTable(content);
	if (!table) return `<p class="note">${escapeHTML(m["share.public.empty"]())}</p>`;
	const rows = table.rows.slice(0, MAX_TABLE_RENDER_ROWS);
	const head = table.header.map((cell) => `<th>${escapeHTML(cell)}</th>`).join("");
	const body = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${escapeHTML(cell)}</td>`).join("")}</tr>`)
		.join("");
	const more =
		table.rows.length > rows.length
			? `<p class="note">${escapeHTML(m["share.public.table_truncated"]({ rows: rows.length }))}</p>`
			: "";
	return `<div class="grid"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

export function downloadName(share: SharedArtifact): string {
	const snapshot = share.snapshot;
	if (snapshot.kind === "file") return snapshot.name;
	return artifactFileName({
		identifier: share.artifactId,
		type: snapshot.type,
		title: snapshot.title,
		language: snapshot.language,
		content: snapshot.content,
		complete: true,
		op: "create",
		version: snapshot.version,
		messageId: "",
	});
}

/**
 * The read-only viewer for what does not run: Markdown, a table, source, and a
 * stored file (a title, the band, a download button). It uses the app's own
 * Markdown and CSV renderers, which need nothing from the app shell.
 */
export function viewerPage(
	share: SharedArtifact,
	filePath: string,
	locale: string
): { html: string; csp: string } {
	const snapshot = share.snapshot;
	let content = "";
	if (snapshot.kind === "text") {
		if (snapshot.type === "markdown")
			content = `<div class="doc">${renderMarkdown(snapshot.content)}</div>`;
		else if (snapshot.type === "table") content = renderTable(snapshot.content);
		else content = `<div class="doc"><pre>${escapeHTML(snapshot.content)}</pre></div>`;
	}
	const meta =
		snapshot.kind === "file"
			? m["share.public.file_meta"]({ size: humanSize(snapshot.size) })
			: m["share.public.shared_by"]({ name: share.ownerName });
	const body = `<div class="top"><main>
<h1 class="title">${escapeHTML(title(share))}</h1>
<p class="meta">${escapeHTML(meta)}</p>
<p><a class="btn" href="${escapeHTML(filePath)}" download>${escapeHTML(m["share.public.download"]())}</a></p>
${content}
</main></div>`;
	return shell(title(share), bandFor(share), body, { locale });
}

export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one answer for an unknown, revoked, expired or switched-off link. */
export function unavailablePage(locale: string): { html: string; csp: string } {
	const body = `<div class="top"><main><h1 class="title">${escapeHTML(m["share.public.unavailable_title"]())}</h1><p>${escapeHTML(m["share.public.unavailable_body"]())}</p></main></div>`;
	// No band: there is no content, and no owner to name.
	return shell(m["share.public.unavailable_title"](), m["share.public.unavailable_band"](), body, {
		locale,
	});
}

/** A download's content type: a short allowlist of types browsers will not run, else bytes. */
const SAFE_DOWNLOAD_TYPES = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"text/plain",
	"text/csv",
	"application/json",
	"application/zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function safeContentType(mime: string): string {
	const type = mime.split(";")[0].trim().toLowerCase();
	return SAFE_DOWNLOAD_TYPES.has(type) ? type : "application/octet-stream";
}

export function attachmentHeaders(name: string, mime: string, size?: number): Headers {
	const headers = publicHeaders({
		"Content-Type": safeContentType(mime),
		"Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\/]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		"Content-Security-Policy": "default-src 'none'; sandbox",
	});
	if (size !== undefined) headers.set("Content-Length", String(size));
	return headers;
}
