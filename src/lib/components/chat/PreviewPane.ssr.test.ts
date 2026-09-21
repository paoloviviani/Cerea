import { render } from "svelte/server";
import { describe, it, expect, beforeEach } from "vitest";
import PreviewPane from "./PreviewPane.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

/**
 * The pane mounts unconditionally in ChatWindow, so unlike the old modal its
 * setup runs during server rendering too — and Svelte executes onDestroy
 * after SSR (onMount is client-only, onDestroy is not). A window touch in
 * the teardown path 500s every page load; these tests pin the server-safe
 * contract.
 */
beforeEach(() => {
	sidePane.reset();
});

describe("PreviewPane SSR", () => {
	it("renders nothing closed without touching window", () => {
		const { body } = render(PreviewPane, {});
		expect(body).not.toContain("iframe");
	});

	it("renders an open preview without touching window", () => {
		sidePane.openPreview({
			kind: "html",
			title: "index.html",
			content: "<h1>Hi</h1>",
		});
		const { body } = render(PreviewPane, {});
		expect(body).toContain("iframe");
		expect(body).toContain("index.html");
	});
});
