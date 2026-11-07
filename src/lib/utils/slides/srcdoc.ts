/**
 * The srcdoc of a slides artifact (ADR 0111): reveal.js and its Markdown
 * plugin, inlined from the npm package so a deck renders offline, inside the
 * same sandbox, CSP and error/link hook as every other preview. Loaded
 * lazily (about 220 kB of text) the first time a deck is shown.
 *
 * Deviations from stock reveal.js, all because the sandbox forbids them or a
 * heavier dependency would buy nothing: no notes plugin (its speaker view is
 * a popup; notes show in a drawer instead), no highlight plugin (code is
 * pre-highlighted by the app, see deck.ts), no math plugin (it fetches KaTeX
 * from a CDN).
 */
import revealJs from "reveal.js/dist/reveal.js?raw";
import revealCss from "reveal.js/dist/reveal.css?raw";
import resetCss from "reveal.js/dist/reset.css?raw";
import markdownJs from "reveal.js/plugin/markdown/markdown.js?raw";
import baseCss from "./slides.css?raw";
import cereaThemeCss from "./cerea-theme.css?raw";
import neutralCss from "./neutral.css?raw";
import whiteCss from "reveal.js/dist/theme/white.css?raw";
import blackCss from "reveal.js/dist/theme/black.css?raw";
import simpleCss from "reveal.js/dist/theme/simple.css?raw";
import moonCss from "reveal.js/dist/theme/moon.css?raw";
import solarizedCss from "reveal.js/dist/theme/solarized.css?raw";
import draculaCss from "reveal.js/dist/theme/dracula.css?raw";
import { buildPreviewHookScript, previewCspMeta } from "../previewSrcdoc";
import { highlightFences, parseDeck, type ParsedDeck } from "./deck";
import { isBuiltinTheme, resolveTheme, type OrgSlideDefaults, type ThemeId } from "./themes";

const BUILTIN_CSS: Record<string, string> = {
	white: whiteCss,
	black: blackCss,
	simple: simpleCss,
	moon: moonCss,
	solarized: solarizedCss,
	dracula: draculaCss,
};

/**
 * A reveal.js theme without its `@import`s: they pull web fonts from Google
 * (blocked by the sandbox's CSP and unwanted offline) or from the package's
 * font folder. The fonts named in the theme fall back to system fonts.
 */
export function stripImports(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s+url\([^)]*\)\s*;?/gi, "");
}

/**
 * reveal.css's one non-structural default: the viewport (the body) carries a
 * white background, black text and line-height 1. Taken out, so the neutral
 * base and the model's own `body {}` rules decide, as they would anywhere.
 */
export function engineCss(css: string): string {
	return css.replace("line-height:1;margin:0;background-color:#fff;color:#000;", "margin:0;");
}

export function themeCss(theme: ThemeId | undefined): string {
	if (!theme) return "";
	return isBuiltinTheme(theme) ? stripImports(BUILTIN_CSS[theme]) : cereaThemeCss;
}

export interface SlidesSrcdocOptions {
	org?: OrgSlideDefaults;
	/** Resolve a logo file name from the chat to a data: URL; absent or null drops it */
	logoDataUrl?: string;
	/** The code highlighter (the app's own); plain text without it */
	highlight?: (code: string, lang?: string) => string;
	/** Offscreen render for the PDF: no transitions, controls, keyboard or fragments */
	pdf?: boolean;
}

const END_SCRIPT = "</scr" + "ipt>";

/** Plain text for the textarea that carries the Markdown: textContent returns the original. */
function textareaSafe(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The script that starts reveal and talks to the app (state out, commands in, captures for the PDF). */
function runtimeScript(channel: string, pdf: boolean, markdown: boolean): string {
	return `\n<script>
(function(){
  var CH = ${JSON.stringify(channel)};
  var PDF = ${pdf ? "true" : "false"};
  var MD = ${markdown ? "true" : "false"};
  function send(type, detail){ try { parent.postMessage({ type: type, channel: CH, detail: detail }, '*'); } catch (e) {} }
  var notesEl = document.querySelector('.cerea-notes');
  var notesOpen = false;
  var deck = new Reveal({
    plugins: [RevealMarkdown],
    width: 1280, height: 720, margin: MD && !PDF ? 0.04 : 0, minScale: PDF ? 1 : 0.1, maxScale: PDF ? 1 : 2,
    center: MD, hash: false, history: false, controls: false, progress: !PDF, slideNumber: false,
    transition: PDF ? 'none' : 'slide', backgroundTransition: 'none', keyboard: !PDF, touch: !PDF,
    fragments: !PDF, help: true, overview: !PDF, mouseWheel: false, respondToHashChanges: false, scrollActivationWidth: null, view: null
  });
  function notes(){
    try {
      var slide = deck.getCurrentSlide();
      var aside = slide && slide.querySelector('aside.notes');
      return aside ? (aside.textContent || '').trim() : '';
    } catch (e) { return ''; }
  }
  function publish(){
    var text = notes();
    if (notesEl) { notesEl.textContent = text || ''; notesEl.hidden = !(notesOpen && text); }
    send('chatui.slides.state', {
      index: deck.getState().indexh || 0, total: deck.getTotalSlides(), notes: !!text, notesOpen: notesOpen
    });
  }
  deck.initialize().then(function(){
    deck.on('slidechanged', publish); deck.on('fragmentshown', publish); deck.on('fragmenthidden', publish);
    publish();
  });
  window.addEventListener('keydown', function(ev){
    if (PDF || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'n' || ev.key === 'N' || ev.key === 's' || ev.key === 'S') { notesOpen = !notesOpen; publish(); }
  });
  window.addEventListener('message', function(ev){
    if (ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || data.channel !== CH) return;
    var d = data.detail || {};
    if (data.type === 'chatui.slides.cmd') {
      if (d.cmd === 'prev') deck.prev();
      else if (d.cmd === 'next') deck.next();
      else if (d.cmd === 'first') deck.slide(0);
      else if (d.cmd === 'last') deck.slide(deck.getTotalSlides() - 1);
      else if (d.cmd === 'notes') { notesOpen = !notesOpen; publish(); }
    } else if (data.type === 'chatui.slides.capture') {
      var id = typeof d.id === 'string' ? d.id : '';
      function fail(err){ send('chatui.slides.captureResult', { id: id, error: String(err && err.message ? err.message : err) }); }
      try {
        if (!window.snapdom) {
          if (typeof d.source !== 'string' || !d.source) { fail('capture library missing'); return; }
          var s = document.createElement('script');
          s.textContent = d.source;
          document.head.appendChild(s);
          s.remove();
          if (!window.snapdom) { fail('capture library failed to initialize'); return; }
        }
        deck.slide(Number(d.index) || 0);
        var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        fonts.then(function(){
          // Timers, not requestAnimationFrame: an offscreen cross-origin frame gets no animation frames
          setTimeout(function(){ setTimeout(function(){
            window.snapdom.toCanvas(document.body, {
              dpr: 1, scale: 1, backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
              embedFonts: false, fast: true
            }).then(function(canvas){
              send('chatui.slides.captureResult', { id: id, dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
            }).catch(fail);
          }, 80); }, 80);
        });
      } catch (err) { fail(err); }
    }
  });
})();
${END_SCRIPT}`;
}

export function buildSlidesSrcdocFrom(
	parsed: ParsedDeck,
	channel: string,
	opts: SlidesSrcdocOptions = {}
): string {
	const markdown = parsed.mode === "markdown";
	const theme = resolveTheme(parsed.meta, opts.org);
	// A logo that is still a file name cannot be shown: only a data: URL is. The
	// resolved one also becomes --brand-logo-url, for the model to place.
	const logoUrl = opts.logoDataUrl ?? (theme.logo?.startsWith("data:") ? theme.logo : undefined);
	const brand =
		logoUrl && logoUrl !== theme.logo ? `:root{--brand-logo-url:url("${logoUrl}");}` : "";
	const title = (parsed.meta.title ?? "Slides").replace(/[<>&"]/g, "");
	const slides = markdown
		? `<div class="slides md">
<section data-markdown data-separator="\\r?\\n---[ \\t]*\\r?\\n" data-separator-notes="^Note:" data-charset="utf-8"><textarea data-template>${textareaSafe(
				opts.highlight ? highlightFences(parsed.body, opts.highlight) : parsed.body
			)}</textarea></section>
</div>`
		: `<div class="slides">\n${parsed.body}\n</div>`;
	// The logo image is a Markdown-deck nicety; an HTML deck places --brand-logo-url itself
	const logoImg =
		markdown && logoUrl ? `<img class="cerea-logo" alt="" src="${attr(logoUrl)}">` : "";
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">${previewCspMeta(channel)}
<title>${title}</title>
<style>${resetCss}</style>
<style>${engineCss(revealCss)}</style>
<style>${neutralCss}</style>
<style>${themeCss(theme.theme)}</style>
<style>${theme.css}${brand}</style>
<style>${baseCss}</style>${buildPreviewHookScript(channel)}
</head>
<body>
<div class="reveal">${slides}${logoImg}<div class="cerea-notes" hidden></div></div>
<script>${revealJs.replace(/<\/script/gi, "<\\/script")}${END_SCRIPT}
<script>${markdownJs.replace(/<\/script/gi, "<\\/script")}${END_SCRIPT}${runtimeScript(channel, !!opts.pdf, markdown)}
</body></html>`;
}

/** Build the srcdoc for a slides artifact's Markdown. */
export function buildSlidesSrcdoc(
	content: string,
	channel: string,
	opts: SlidesSrcdocOptions = {}
): string {
	return buildSlidesSrcdocFrom(parseDeck(content), channel, opts);
}
