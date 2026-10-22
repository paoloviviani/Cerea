import { describe, it, expect, vi } from "vitest";

/**
 * A worker that dies on its first job, the way a failed chunk load or an OS reclaim looks
 * to the pool: `onerror` fires and no reply ever comes.
 */
vi.mock("$lib/workers/markdownWorker?worker", () => ({
	default: class DyingWorker {
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onmessageerror: ((event: MessageEvent) => void) | null = null;
		postMessage() {
			setTimeout(() => this.onerror?.(new Event("error")), 0);
		}
		terminate() {}
	},
}));

const { acquireMarkdownClientId, renderMarkdownBlocks } = await import("./markdownWorkerPool");

describe("markdownWorkerPool when a worker dies mid-render", () => {
	it("renders the orphaned job on the main thread, not as plain text", async () => {
		const blocks = await new Promise<Array<{ id: string; tokens: Array<{ type: string }> }>>(
			(resolve) =>
				renderMarkdownBlocks(
					acquireMarkdownClientId(),
					"Here:\n\n```python\nprint('hi')\n```\n",
					[],
					false,
					(result) => resolve(result as never)
				)
		);
		// The plain-text fallback is one block with a single text token; nothing renders
		// a finished message again, so it would stay that way.
		expect(blocks.some((block) => block.id === "fallback")).toBe(false);
		expect(blocks.flatMap((block) => block.tokens).some((token) => token.type === "code")).toBe(
			true
		);
	});
});
