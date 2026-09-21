import { browser } from "$app/environment";

// Loose absolute bounds for a resized width; the real visual bounds are
// proportional (each pane keeps at least 20% of the chat/panel split, see
// SidePane), so neither side can be dragged into oblivion.
export const SIDE_PANE_MIN_WIDTH = 300;
export const SIDE_PANE_MAX_WIDTH = 2400;
/** Default split when the user hasn't resized: the pane takes 60%, the chat keeps 40% */
export const SIDE_PANE_DEFAULT_FRACTION = "60%";

/** Which view owns the pane. One slot, so the views are mutually exclusive. */
export type SidePaneView = "artifact" | "trackio" | "library" | "preview";

/**
 * A one-shot rendered view of a single fence or file: no registry entry, no
 * versions, no persistence. The content lives in the message that produced
 * the Preview button, so the store only holds what is showing right now —
 * like the library view, this one is outside the pane-item nav axis.
 */
export interface FencePreview {
	/**
	 * Rendered through buildArtifactSrcdoc, same builders as artifact
	 * previews — except "pdf", which is not an ArtifactKind: a document the
	 * browser renders natively, carried as a data: URL and framed directly.
	 */
	kind: "html" | "svg" | "mermaid" | "pdf";
	/** Shown in the pane header: the annotated filename, or a generic label. */
	title: string;
	/**
	 * The fence's raw source, rendered verbatim — or, for "pdf", the whole
	 * document as a data: URL (bytes travel with the payload, so no blob
	 * lifetime to manage across panel open/close).
	 */
	content: string;
}

/**
 * UI state for the side pane. Its content is always derived from the
 * conversation messages — artifacts via `collectArtifacts`, Trackio dashboards
 * via `collectTrackioDashboards` — so this store only tracks what is showing
 * and how wide it is.
 *
 * The geometry (width, resize, open/close) is shared by every view; the fields
 * below it are still artifact-specific and would be worth splitting per view
 * once a second view needs state of its own.
 */
class SidePaneStore {
	open = $state(false);
	view = $state<SidePaneView>("artifact");
	/** The framed Trackio dashboard, when `view` is "trackio". */
	trackio = $state<{ url: string; label: string } | null>(null);
	/**
	 * The transient fence/file preview, when `view` is "preview". Deliberately
	 * not derived from the messages (unlike artifacts and dashboards): the
	 * content is already in the message, and re-deriving it would promote a
	 * one-shot view into pane state that must survive branch switches.
	 */
	preview = $state<FencePreview | null>(null);
	identifier = $state<string | null>(null);
	/** 1-based version to display; null follows the latest version (including streaming growth) */
	version = $state<number | null>(null);
	tab = $state<"preview" | "code">("preview");
	/** Set when the user explicitly picked a tab, so we stop auto-switching */
	userPinnedTab = $state(false);
	/**
	 * Resized pixel width from a drag, or null to use the default 40/60 chat/panel split.
	 * Deliberately not persisted: a fresh load or a new conversation always
	 * starts at the default instead of restoring an earlier drag.
	 */
	widthPx = $state<number | null>(null);
	/** Word wrap in the code view (persisted) */
	codeWrap = $state(browser && localStorage.getItem("artifactPanelCodeWrap") === "true");
	/** Code tab shows the diff vs the previous version (edit versions only) */
	diffView = $state(true);
	/**
	 * Bumped on every explicit open so the panel re-anchors its scroll even
	 * when the target view didn't change (e.g. clicking the same card again
	 * after the view streamed pinned to the bottom).
	 */
	revealNonce = $state(0);

	toggleCodeWrap() {
		this.codeWrap = !this.codeWrap;
		if (browser) {
			localStorage.setItem("artifactPanelCodeWrap", String(this.codeWrap));
		}
	}

	toggleDiffView() {
		this.diffView = !this.diffView;
	}

	/** Versions we already auto-opened for, so closing the panel mid-stream sticks */
	private autoOpenedKeys = new Set<string>();

	openArtifact(identifier: string, version: number | null = null) {
		if (this.identifier !== identifier) {
			this.tab = "preview";
			this.userPinnedTab = false;
		}
		this.view = "artifact";
		this.identifier = identifier;
		this.version = version;
		this.open = true;
		this.revealNonce += 1;
	}

	/** Open once per streaming version; respects the user closing the panel mid-stream. */
	maybeAutoOpen(identifier: string, version: number) {
		const key = `${identifier}:${version}`;
		if (this.autoOpenedKeys.has(key)) return;
		this.autoOpenedKeys.add(key);
		this.openArtifact(identifier, null);
	}

	openTrackio(url: string, label: string) {
		this.view = "trackio";
		this.trackio = { url, label };
		this.open = true;
		this.revealNonce += 1;
	}

	/**
	 * Open a one-shot rendered view of a fence or file. Every explicit open
	 * re-anchors (same revealNonce contract as artifacts) so pressing Preview
	 * on the same block twice still brings the pane back.
	 */
	openPreview(preview: FencePreview) {
		this.view = "preview";
		this.preview = preview;
		this.open = true;
		this.revealNonce += 1;
	}

	/**
	 * The conversation's persisted deliverables plus the chat export. Unlike
	 * the artifact/trackio views this one is not part of the pane-item axis
	 * (it lists stored files, not message-derived views), so it carries no
	 * selection of its own.
	 */
	openLibrary() {
		this.view = "library";
		this.open = true;
		this.revealNonce += 1;
	}

	/**
	 * What the button in the chat header does. A control that only ever opens
	 * is a control you cannot undo: the way back out was the pane's own close,
	 * which is a different target from the one just pressed.
	 *
	 * Only the library view toggles shut — pressing it while an artifact or a
	 * dashboard is showing switches to the library, because the press means
	 * "show me the files", not "close whatever that was".
	 */
	toggleLibrary() {
		if (this.open && this.view === "library") {
			this.close();
			return;
		}
		this.openLibrary();
	}

	/**
	 * Open a dashboard the first time it appears, once per URL — a dashboard is
	 * live for the whole run, so re-opening it on every log poll would fight the
	 * user closing the pane to read the chat.
	 */
	maybeAutoOpenTrackio(url: string, label: string) {
		const key = `trackio:${url}`;
		if (this.autoOpenedKeys.has(key)) return;
		this.autoOpenedKeys.add(key);
		this.openTrackio(url, label);
	}

	selectTab(tab: "preview" | "code") {
		this.tab = tab;
		this.userPinnedTab = true;
	}

	setWidth(px: number) {
		this.widthPx = Math.min(SIDE_PANE_MAX_WIDTH, Math.max(SIDE_PANE_MIN_WIDTH, px));
	}

	/** Back to the default 40/60 chat/panel split */
	resetWidth() {
		this.widthPx = null;
	}

	close() {
		this.open = false;
	}

	/** Full reset, used when switching conversations. */
	reset() {
		this.open = false;
		this.view = "artifact";
		this.trackio = null;
		this.preview = null;
		this.identifier = null;
		this.version = null;
		this.tab = "preview";
		this.userPinnedTab = false;
		this.diffView = true;
		this.widthPx = null;
		this.autoOpenedKeys.clear();
	}
}

export const sidePane = new SidePaneStore();
