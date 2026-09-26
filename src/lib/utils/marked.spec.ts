import { describe, expect, test } from "vitest";
import { fallbackBlocks, highlightCode, processBlocksSync, processTokensSync } from "./marked";

function renderHtml(md: string): string {
	const tokens = processTokensSync(md, []);
	const textToken = tokens.find((token) => token.type === "text");
	if (!textToken || textToken.type !== "text") return "";
	return typeof textToken.html === "string" ? textToken.html : "";
}

// Full pipeline render (block splitting + optional streaming repairs), as used by MarkdownRenderer
function renderBlocksHtml(md: string, streaming: boolean): string {
	return processBlocksSync(md, [], streaming)
		.flatMap((block) => block.tokens)
		.map((token) => (token.type === "text" && typeof token.html === "string" ? token.html : ""))
		.join("");
}

describe("marked basic rendering", () => {
	test("renders bold text", () => {
		const html = renderHtml("**bold**");
		expect(html).toContain("<strong>bold</strong>");
	});

	test("renders links", () => {
		const html = renderHtml("[link](https://example.com)");
		expect(html).toContain('<a href="https://example.com"');
		expect(html).toContain("link</a>");
	});

	test("renders paragraphs", () => {
		const html = renderHtml("hello world");
		expect(html).toContain("<p>hello world</p>");
	});
});

describe("marked math rendering", () => {
	test("renders inline $math$ with KaTeX, as the artifact panel does for markdown", () => {
		const html = renderBlocksHtml("Einstein said $E = mc^2$ once.", false);
		expect(html).toContain("katex");
		expect(html).not.toContain("$E = mc^2$");
	});

	test("renders $$display math$$ with KaTeX in display mode", () => {
		const html = renderBlocksHtml("$$\nE = mc^2\n$$", false);
		expect(html).toContain("katex-display");
	});

	test("a mid-sentence $$...$$ in running prose renders as math with no stray dollars", () => {
		const html = renderBlocksHtml("the integral $$\\int_0^1 x^2\\,dx$$ equals one third.", false);
		expect(html).toContain("katex");
		expect(html).not.toContain("$");
	});

	// The reported bug: a `$$...$$` that a container tokenizes directly as
	// inline (a list item, same as a heading or a table cell) reached the
	// single-$ rule, which paired the second `$` of the opening `$$` with
	// the first `$` of the closing `$$` — an inline (not display) render
	// with the outer two `$` left stranded as text on each side.
	test("a mid-sentence $$...$$ inside a list item renders as math with no stray dollars", () => {
		const html = renderBlocksHtml("- the integral $$\\int_0^1 x^2\\,dx$$ equals one third.", false);
		expect(html).toContain("katex");
		expect(html).not.toContain("$");
	});

	test("currency stays text, not math", () => {
		const html = renderBlocksHtml("It costs $5 and $10 for two.", false);
		expect(html).not.toContain("katex");
		expect(html).toContain("$5 and $10");
	});

	test("an escaped \\$ stays a literal dollar sign", () => {
		const html = renderBlocksHtml("It costs \\$5.", false);
		expect(html).not.toContain("katex");
		expect(html).toContain("$5");
	});

	test("$$ inside an inline code span is code, not math", () => {
		const html = renderBlocksHtml("Use `$$x$$` in your template.", false);
		expect(html).not.toContain("katex");
		expect(html).toContain("<code>$$x$$</code>");
	});

	test("$$ inside a fenced code block is code, not math", () => {
		const tokens = processTokensSync("```\n$$x$$\n```", []);
		const code = tokens.find((t) => t.type === "code");
		expect(code && code.type === "code" ? code.rawCode : "").toBe("$$x$$");
		expect(tokens.some((t) => t.type === "text")).toBe(false);
	});
});

describe("marked image renderer", () => {
	test("renders video extensions as <video>", () => {
		const html = renderHtml("![](https://example.com/clip.mp4)");
		expect(html).toContain("<video controls");
		expect(html).toContain('<source src="https://example.com/clip.mp4">');
	});

	test("renders audio extensions as <audio>", () => {
		const html = renderHtml("![](https://example.com/clip.mp3)");
		expect(html).toContain("<audio controls");
		expect(html).toContain('<source src="https://example.com/clip.mp3">');
	});

	test("renders non-video images as <img>", () => {
		const html = renderHtml("![](https://example.com/pic.png)");
		expect(html).toContain('<img src="https://example.com/pic.png"');
	});

	test("renders video with query params", () => {
		const html = renderHtml("![](https://example.com/clip.mp4?token=abc)");
		expect(html).toContain("<video controls");
		expect(html).toContain("clip.mp4?token=abc");
	});
});

describe("marked html video tag support", () => {
	test("allows raw <video> tags with controls", () => {
		const html = renderHtml('<video controls src="https://example.com/video.mp4"></video>');
		expect(html).toContain("<video");
		expect(html).toContain("controls");
		expect(html).toContain('src="https://example.com/video.mp4"');
	});

	test("allows <video> with nested <source> tags", () => {
		const html = renderHtml(
			'<video controls><source src="https://example.com/video.webm" type="video/webm"></video>'
		);
		expect(html).toContain("<video");
		expect(html).toContain("<source");
		expect(html).toContain('src="https://example.com/video.webm"');
	});

	test("strips disallowed attributes from video tags", () => {
		const html = renderHtml('<video onclick="alert(1)" src="https://example.com/v.mp4"></video>');
		expect(html).toContain("<video");
		expect(html).not.toContain("onclick");
	});

	test("strips javascript: URLs from media sources", () => {
		const html = renderHtml('<video controls src="javascript:alert(1)"></video>');
		expect(html).not.toContain("javascript:");
	});

	test("escapes disallowed html tags", () => {
		const html = renderHtml("<script>alert(1)</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("allows <audio> tags with controls", () => {
		const html = renderHtml(
			'<audio controls><source src="https://example.com/audio.mp3" type="audio/mpeg"></audio>'
		);
		expect(html).toContain("<audio");
		expect(html).toContain("<source");
		expect(html).toContain('type="audio/mpeg"');
	});
});

describe("streaming incomplete markdown", () => {
	test("incomplete link renders as inert anchor, not a dead clickable link", () => {
		const html = renderBlocksHtml("Check [the docs](https://exam", true);
		expect(html).toContain("<a data-incomplete-link>the docs</a>");
		expect(html).not.toContain("streamdown:incomplete-link");
		expect(html).not.toContain("target=");
	});

	test("incomplete link text renders as inert anchor", () => {
		const html = renderBlocksHtml("Check [the doc", true);
		expect(html).toContain("<a data-incomplete-link>the doc</a>");
	});

	test("complete links keep their href", () => {
		const html = renderBlocksHtml("Check [the docs](https://example.com)", true);
		expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">');
		expect(html).not.toContain("data-incomplete-link");
	});

	test("incomplete bold renders as bold", () => {
		const html = renderBlocksHtml("Some **important tex", true);
		expect(html).toContain("<strong>important tex</strong>");
	});

	test("incomplete inline code renders as code", () => {
		const html = renderBlocksHtml("Run `npm insta", true);
		expect(html).toContain("<code>npm insta</code>");
	});

	test("partial trailing HTML tag does not flash as raw text", () => {
		const html = renderBlocksHtml("Some text <video contro", true);
		expect(html).toContain("Some text");
		expect(html).not.toContain("video contro");
	});

	test("lone dash while a list streams in does not flash previous text as heading", () => {
		const html = renderBlocksHtml("Shopping list:\n-", true);
		expect(html).not.toContain("<h2>");
		expect(html).toContain("Shopping list:");
	});

	test("single tilde ranges do not flash as strikethrough", () => {
		const html = renderBlocksHtml("Heat to 20~25°C", true);
		expect(html).not.toContain("<del>");
		expect(html).toContain("20~25°C");
	});

	test("comparison operator in list items does not render a blockquote", () => {
		const html = renderBlocksHtml("- > 25: expensive", true);
		expect(html).not.toContain("<blockquote>");
		expect(html).toContain("&gt; 25: expensive");
	});
});

describe("completed messages render unmodified markdown", () => {
	test("a trailing setext heading still renders as a heading", () => {
		// Regression: remend's setext flash guard must not rewrite completed content
		const html = renderBlocksHtml("Title\n-", false);
		expect(html).toContain("<h2>Title</h2>");
	});

	test("the same trailing setext heading is guarded while streaming", () => {
		const html = renderBlocksHtml("Title\n-", true);
		expect(html).not.toContain("<h2>");
	});

	test("incomplete markers in completed content render literally", () => {
		const html = renderBlocksHtml("Some **truncated outpu", false);
		expect(html).toContain("**truncated outpu");
		expect(html).not.toContain("<strong>");
	});

	test("incomplete links in completed content render literally", () => {
		const html = renderBlocksHtml("Check [the docs](https://exam", false);
		expect(html).not.toContain("data-incomplete-link");
		// Bracket syntax stays literal text (the bare URL may still be autolinked by GFM)
		expect(html).toContain("[the docs](");
	});
});

describe("file blocks (direct emission)", () => {
	test("a closed titled fence becomes one code token carrying the full info string", () => {
		const tokens = processTokensSync("```markdown title=report.md\n# Report\nBody.\n```", []);
		const code = tokens.find((t) => t.type === "code");
		expect(code).toMatchObject({
			type: "code",
			// CodeBlock detects the annotation off this string, so it must survive
			// the pipeline whole — not truncated to the first word.
			lang: "markdown title=report.md",
			isClosed: true,
		});
		// The bytes the card will offer for download are the fence content verbatim.
		expect(code && code.type === "code" ? code.rawCode : "").toBe("# Report\nBody.");
	});

	test("an unclosed titled fence streams as a code block (isClosed false)", () => {
		const tokens = processTokensSync("```markdown title=report.md\n# Report\nBody still", []);
		const code = tokens.find((t) => t.type === "code");
		expect(code && code.type === "code" ? code.isClosed : true).toBe(false);
	});

	test("a closing fence inside the content is handled by a longer outer fence", () => {
		const content = [
			"````markdown title=quoting.md",
			"Say the fence is ``` like this.",
			"Still inside.",
			"````",
		].join("\n");
		const tokens = processTokensSync(content, []);
		expect(tokens.filter((t) => t.type === "code")).toHaveLength(1);
		const code = tokens.find((t) => t.type === "code");
		expect(code && code.type === "code" ? code.isClosed : false).toBe(true);
		expect(code && code.type === "code" ? code.rawCode : "").toContain("``` like this.");
	});
});

describe("processBlocksSync streaming behavior", () => {
	test("regex character classes in code do not collapse the document into one block", () => {
		const content = [
			"Match whitespace:",
			"",
			"```js",
			"const re = /[^\\s>]+/;",
			"```",
			"",
			"And some trailing explanation.",
		].join("\n");
		const blocks = processBlocksSync(content, []);
		expect(blocks.length).toBeGreaterThan(1);
	});

	test("block ids of completed blocks are stable while streaming and after completion", () => {
		const full = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
		// Final render: completed message, no streaming repairs
		const fullIds = processBlocksSync(full, [], false).map((b) => b.id);
		// Mid-stream render: third paragraph still arriving, repairs active
		const partialIds = processBlocksSync(`${full.slice(0, -10)}`, [], true).map((b) => b.id);
		expect(partialIds.slice(0, -1)).toEqual(fullIds.slice(0, partialIds.length - 1));
	});
});

describe("event-loop guards for oversized inputs (SSR)", () => {
	test("small code with a known language is highlighted normally", () => {
		const html = highlightCode("const x = 1;", "javascript");
		expect(html).toContain('class="hljs');
	});

	test("very large code blocks are not highlighted (escaped plain text)", () => {
		const huge = "<x>".repeat(20_000); // 60k chars, > MAX_HIGHLIGHT_LENGTH
		const html = highlightCode(huge, "javascript");
		expect(html).not.toContain('class="hljs');
		expect(html).toContain("&lt;x&gt;");
	});

	test("medium unlabeled code blocks skip expensive auto-detection (escaped plain text)", () => {
		const medium = "<y>".repeat(2_000); // 6k chars, > MAX_AUTO_HIGHLIGHT_LENGTH, no language
		const html = highlightCode(medium);
		expect(html).not.toContain('class="hljs');
		expect(html).toContain("&lt;y&gt;");
	});

	test("huge katex blocks are not rendered with katex (escaped raw)", () => {
		const huge = `$$${"a".repeat(11_000)}$$`; // > MAX_KATEX_LENGTH
		const html = processTokensSync(huge, [])
			.map((token) => (token.type === "text" && typeof token.html === "string" ? token.html : ""))
			.join("");
		expect(html).not.toContain("katex");
	});
});

describe("fallbackBlocks (SSR / initial render)", () => {
	test("does not run highlight.js, katex or produce code tokens", () => {
		const content = [
			"# Title",
			"",
			"Some **text** with math $x^2$ and a code block:",
			"",
			"```python",
			"print('hello')",
			"```",
		].join("\n");
		const blocks = fallbackBlocks(content);
		expect(blocks).toHaveLength(1);
		const tokens = blocks[0].tokens;
		// Single text token, no code tokens (CodeBlock => DOMPurify/jsdom on the server)
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe("text");
		const html =
			tokens[0].type === "text" && typeof tokens[0].html === "string" ? tokens[0].html : "";
		expect(html).not.toContain("hljs");
		expect(html).not.toContain("katex");
	});

	test("escapes html so raw markdown content is inert", () => {
		const blocks = fallbackBlocks("<img src=x onerror=alert(1)>");
		const html =
			blocks[0].tokens[0].type === "text" && typeof blocks[0].tokens[0].html === "string"
				? blocks[0].tokens[0].html
				: "";
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	test("is deterministic (stable id and html) for identical content", () => {
		const a = fallbackBlocks("hello world");
		const b = fallbackBlocks("hello world");
		expect(a[0].id).toBe(b[0].id);
		expect(a[0].tokens).toEqual(b[0].tokens);
	});
});
