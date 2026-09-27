import MarkdownRenderer from "./MarkdownRenderer.svelte";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import { tick } from "svelte";
import { getRunsStore } from "$lib/utils/execution/runs.svelte";
import { chatRunKey } from "$lib/utils/execution/keys";

import { describe, expect, it, vi } from "vitest";

// Rich markdown rendering is deferred to the markdown worker (or async processBlocks)
// on mount; the first paint shows a lightweight escaped-text fallback. Assertions on
// the rendered output therefore wait for the asynchronous upgrade.

describe("MarkdownRenderer", () => {
	it("renders", async () => {
		render(MarkdownRenderer, { content: "Hello, world!" });
		await expect.element(page.getByText("Hello, world!")).toBeInTheDocument();
	});
	it("renders headings", async () => {
		render(MarkdownRenderer, { content: "# Hello, world!" });
		await expect.element(page.getByRole("heading", { level: 1 })).toBeInTheDocument();
	});
	it("renders links", async () => {
		render(MarkdownRenderer, { content: "[Hello, world!](https://example.com)" });
		const link = page.getByRole("link", { name: "Hello, world!" });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute("href", "https://example.com");
		await expect.element(link).toHaveAttribute("target", "_blank");
		await expect.element(link).toHaveAttribute("rel", "noreferrer");
	});
	it("renders inline codespans", async () => {
		render(MarkdownRenderer, { content: "`foobar`" });
		await expect.element(page.getByRole("code")).toHaveTextContent("foobar");
	});
	it("renders block codes", async () => {
		render(MarkdownRenderer, { content: "```foobar```" });
		await expect.element(page.getByRole("code")).toHaveTextContent("foobar");
	});
	it("doesnt render raw html directly", async () => {
		render(MarkdownRenderer, { content: "<button>Click me</button>" });
		await expect
			.element(page.getByRole("paragraph"))
			.toHaveTextContent("<button>Click me</button>");
		expect(page.getByRole("button").elements()).toHaveLength(0);
	});
	it("renders latex", async () => {
		const { baseElement } = render(MarkdownRenderer, { content: "$(oo)^2$" });
		await vi.waitFor(() => expect(baseElement.querySelectorAll(".katex")).toHaveLength(1));
	});
	it("does not render latex in code blocks", async () => {
		const { baseElement } = render(MarkdownRenderer, { content: "```\n$(oo)^2$\n```" });
		await expect.element(page.getByRole("code")).toBeInTheDocument();
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("does not render latex in inline codes", async () => {
		const { baseElement } = render(MarkdownRenderer, { content: "`$oo` and `$bar`" });
		await expect.element(page.getByText("oo").first()).toBeInTheDocument();
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("does not render latex across multiple lines", async () => {
		const { baseElement } = render(MarkdownRenderer, { content: "* $oo \n* $aa" });
		await expect.element(page.getByRole("listitem").first()).toBeInTheDocument();
		expect(baseElement.querySelectorAll(".katex")).toHaveLength(0);
	});
	it("renders latex with some < and > symbols", async () => {
		const { baseElement } = render(MarkdownRenderer, { content: "$foo < bar > baz$" });
		await vi.waitFor(() => expect(baseElement.querySelectorAll(".katex")).toHaveLength(1));
	});
});

describe("MarkdownRenderer streaming", () => {
	it("renders an incomplete link as an inert anchor without href", async () => {
		const { baseElement } = render(MarkdownRenderer, {
			content: "Check [the docs](https://exam",
			loading: true,
		});
		await vi.waitFor(() => {
			const anchor = baseElement.querySelector("a[data-incomplete-link]");
			expect(anchor).not.toBeNull();
			expect(anchor?.getAttribute("href")).toBeNull();
			expect(anchor?.textContent).toBe("the docs");
		});
	});

	it("renders incomplete bold as bold while streaming", async () => {
		const { baseElement } = render(MarkdownRenderer, {
			content: "Some **important tex",
			loading: true,
		});
		await vi.waitFor(() => {
			const strong = baseElement.querySelector("strong");
			expect(strong?.textContent).toBe("important tex");
		});
	});

	it("does not flash a heading while a list item streams in", async () => {
		const { baseElement } = render(MarkdownRenderer, {
			content: "Shopping list:\n-",
			loading: true,
		});
		await expect.element(page.getByText("Shopping list:")).toBeInTheDocument();
		expect(baseElement.querySelector("h2")).toBeNull();
	});

	it("does not merge paragraphs after a <br> into one block", async () => {
		const { baseElement } = render(MarkdownRenderer, {
			content: "First paragraph.\n\n<br>\n\nSecond paragraph.\n\nThird paragraph.",
		});
		await vi.waitFor(() => {
			expect(baseElement.textContent).toContain("Second paragraph.");
			expect(baseElement.textContent).toContain("Third paragraph.");
		});
	});

	it("marks a fence that arrives already closed 'seen live' synchronously, without waiting for the async tokenizer", async () => {
		// The bug this guards: some models stream only their thinking and
		// deliver the whole visible answer, fence already closed, in one final
		// chunk. The mark must not depend on the worker round trip (or a cold
		// dynamically-imported rich module) that turns `content` into rendered
		// blocks — that pipeline can easily outlast `loading` flipping false.
		const rawCode = "print('sync-mark')";
		render(MarkdownRenderer, {
			content: `Here:\n\n\`\`\`python\n${rawCode}\n\`\`\`\n`,
			loading: true,
			autorun: true,
		});
		await tick();
		const store = getRunsStore();
		expect(store?.hasSeenStreaming(`|${chatRunKey(rawCode)}`)).toBe(true);
	});

	it("renders a trailing setext heading in completed messages", async () => {
		// Streaming repairs must not apply when loading is false
		const { baseElement } = render(MarkdownRenderer, { content: "Title\n-" });
		// Under full-suite parallel load (several Chromium contexts plus the
		// Mongo download this suite triggers) the worker's first upgrade can
		// take well past the 1s default waitFor budget — this assertion is the
		// one that trips, and it trips on the untouched base commit too. Five
		// seconds keeps the race bounded without loosening what is asserted.
		await vi.waitFor(() => expect(baseElement.querySelector("h2")?.textContent).toBe("Title"), {
			timeout: 5000,
		});
	});
});
