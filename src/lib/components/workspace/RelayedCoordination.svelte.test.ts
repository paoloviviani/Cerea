import { afterEach, describe, expect, it } from "vitest";
import { get, writable } from "svelte/store";
import { renderWithApp, unmountRendered } from "$lib/components/__tests__/renderWithApp";
import RelayedCoordination from "./RelayedCoordination.svelte";

afterEach(() => {
	unmountRendered();
	document.body.innerHTML = "";
});

function mount(initial: Record<string, unknown>, data: Record<string, unknown> = {}) {
	const store = writable<{ activeModel: string; relayedCoordinationEnabled?: boolean }>({
		activeModel: "m",
		...initial,
	});
	const view = renderWithApp(
		RelayedCoordination,
		{},
		{
			context: new Map<unknown, unknown>([["settings", store]]),
			page: { data },
		}
	);
	return { view, store };
}

describe("the relayed-coordination switch (Workspace, Agents)", () => {
	it("is on when nothing was ever saved, and says what it does and that every use still asks", async () => {
		const { view } = mount({});
		const toggle = view.getByRole("checkbox");
		await expect.element(toggle).toBeChecked();
		await expect.element(view.getByText(/each use still asks/)).toBeVisible();
		await expect.element(view.getByText(/read, message and start sessions/)).toBeVisible();
	});

	it("saves false when switched off, and true when switched on again", async () => {
		const { view, store } = mount({});
		await view.getByRole("switch").click();
		expect(get(store).relayedCoordinationEnabled).toBe(false);
		await expect.element(view.getByRole("checkbox")).not.toBeChecked();
		await view.getByRole("switch").click();
		expect(get(store).relayedCoordinationEnabled).toBe(true);
	});

	it("reads an explicit false as off", async () => {
		const { view } = mount({ relayedCoordinationEnabled: false });
		await expect.element(view.getByRole("checkbox")).not.toBeChecked();
	});

	it("says so, and cannot be changed, when the administrator switched the feature off", async () => {
		const { view, store } = mount({}, { codeRelayedCoordinationEnabled: false });
		await expect.element(view.getByTestId("relay-off-here")).toBeVisible();
		view
			.getByRole("switch")
			.element()
			.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(get(store).relayedCoordinationEnabled).toBeUndefined();
	});
});
