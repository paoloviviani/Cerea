/**
 * Where everything goes in the window. The header is a bar across the top; under it the Cerea
 * view takes all the width except the tool panel's, and the tool panel (browser, galopin,
 * profiles) sits at the right when it is open. They never overlap: the Cerea view is exactly
 * `window width - panel width`. With no server chosen there is no Cerea view and no panel: the
 * first-run screen has the whole window.
 */

export const HEADER = 40;
export const PANEL_MIN = 360;
export const PANEL_DEFAULT = 440;
/** At most this share of the window. */
export const PANEL_MAX_SHARE = 0.7;

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutInput {
	/** The window's content size. */
	width: number;
	height: number;
	/** A server (profile) is chosen: otherwise the first-run screen has the whole window. */
	hasServer: boolean;
	open: boolean;
	/** The wanted panel width; clamped here. */
	panelWidth: number;
}

export interface Layout {
	cerea: Rect | null;
	panel: Rect | null;
	/** The width actually used (clamped), for the drag handle and what is remembered. */
	panelWidth: number;
}

export function clampPanelWidth(wanted: number, windowWidth: number): number {
	const max = Math.max(PANEL_MIN, Math.floor(windowWidth * PANEL_MAX_SHARE));
	const w = Number.isFinite(wanted) ? Math.round(wanted) : PANEL_DEFAULT;
	return Math.min(max, Math.max(PANEL_MIN, w));
}

export function computeLayout(i: LayoutInput): Layout {
	const panelWidth = clampPanelWidth(i.panelWidth, i.width);
	const height = Math.max(0, i.height - HEADER);
	if (!i.hasServer) return { cerea: null, panel: null, panelWidth };
	if (!i.open) {
		return { cerea: { x: 0, y: HEADER, width: i.width, height }, panel: null, panelWidth };
	}
	const chat = Math.max(0, i.width - panelWidth);
	return {
		cerea: { x: 0, y: HEADER, width: chat, height },
		panel: { x: chat, y: HEADER, width: panelWidth, height },
		panelWidth,
	};
}
