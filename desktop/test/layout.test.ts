import { describe, expect, it } from "vitest";
import { clampPanelWidth, computeLayout, HEADER, PANEL_MIN } from "../src/main/layout.ts";

const base = { width: 1360, height: 860, hasServer: true, open: false, panelWidth: 440 };

describe("window layout", () => {
	it("gives the Cerea view the whole window under the header when the panel is closed", () => {
		const l = computeLayout(base);
		expect(l.cerea).toEqual({ x: 0, y: HEADER, width: 1360, height: 860 - HEADER });
		expect(l.panel).toBeNull();
	});

	it("shares the width when open: the Cerea view is window minus panel, and they do not overlap", () => {
		const l = computeLayout({ ...base, open: true });
		expect(l.panel).toEqual({ x: 920, y: HEADER, width: 440, height: 860 - HEADER });
		expect(l.cerea).toEqual({ x: 0, y: HEADER, width: 920, height: 860 - HEADER });
		expect(l.cerea!.x + l.cerea!.width).toBe(l.panel!.x);
		expect(l.panel!.x + l.panel!.width).toBe(1360);
	});

	it("follows a resize of the window and of the panel", () => {
		const resized = computeLayout({ ...base, open: true, width: 1000, height: 700 });
		expect(resized.cerea!.width + resized.panel!.width).toBe(1000);
		expect(resized.cerea!.height).toBe(700 - HEADER);
		const wider = computeLayout({ ...base, open: true, panelWidth: 600 });
		expect(wider.panel!.width).toBe(600);
		expect(wider.cerea!.width).toBe(760);
	});

	it("clamps the panel between 360 px and 70% of the window", () => {
		expect(clampPanelWidth(100, 1360)).toBe(PANEL_MIN);
		expect(clampPanelWidth(5000, 1360)).toBe(951);
		expect(clampPanelWidth(NaN, 1360)).toBe(440);
		expect(computeLayout({ ...base, open: true, panelWidth: 5000 }).panel!.width).toBe(951);
		expect(computeLayout({ ...base, open: true, panelWidth: 10 }).panel!.width).toBe(PANEL_MIN);
	});

	it("at the minimum window size (900x560) the chat keeps at least 30% and nothing overlaps", () => {
		const l = computeLayout({ ...base, width: 900, height: 560, open: true, panelWidth: 5000 });
		expect(l.panel!.width).toBe(630);
		expect(l.cerea!.width).toBe(270);
		expect(l.cerea!.width + l.panel!.width).toBe(900);
		const normal = computeLayout({ ...base, width: 900, height: 560, open: true });
		expect(normal.cerea!.width).toBe(460);
		expect(normal.cerea!.height).toBe(560 - HEADER);
	});

	it("never shows the panel or a Cerea view before a server is chosen", () => {
		for (const open of [false, true]) {
			const l = computeLayout({ ...base, hasServer: false, open });
			expect(l.cerea).toBeNull();
			expect(l.panel).toBeNull();
		}
	});

	it("never goes negative in a tiny window", () => {
		const l = computeLayout({ ...base, width: 200, height: 20, open: true });
		expect(l.cerea!.width).toBeGreaterThanOrEqual(0);
		expect(l.cerea!.height).toBe(0);
	});
});
