import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import ChatInput from "./ChatInput.svelte";

vi.mock("$app/state", () => ({
	page: { route: { id: "/" }, params: {}, url: new URL("http://localhost/"), data: {} },
	navigating: { current: null },
	updated: { current: false, check: async () => false },
}));

describe("ChatInput dictation SSR", () => {
	it("renders without a window, and without the mic button", () => {
		expect(typeof window).toBe("undefined");
		const manager = getConfigManager({ PUBLIC_APP_NAME: "chat-ui", PUBLIC_APP_ASSETS: "chatui" });
		const context = new Map<unknown, unknown>([
			["publicConfig", manager],
			["settings", writable({ activeModel: "m" })],
		]);
		const { body } = render(ChatInput, { props: { placeholder: "Ask anything" }, context });
		expect(body).toContain("<textarea");
		// Support is decided in the browser after mount, never on the server.
		expect(body).not.toContain("dictation");
	});
});
