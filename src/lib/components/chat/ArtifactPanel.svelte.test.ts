/* eslint-disable @typescript-eslint/no-non-null-assertion -- assertions on values the test just created */
import ArtifactPanel from "./ArtifactPanel.svelte";
import ArtifactCard from "./ArtifactCard.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { MessageUpdateType, type MessageArtifactDraftUpdate } from "$lib/types/MessageUpdate";
import type { ArtifactRegistry, ArtifactVersion } from "$lib/utils/artifacts";
import { artifactOpKey } from "$lib/utils/artifacts";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

// The two artifact modes the panel serves:
// - inline `<artifact>` blocks, folded into versions by `collectArtifacts`
//   (the registry prop) — a version's `complete` flips the moment its closing
//   tag streams in, mid-turn;
// - tool-mode drafts (`drafts` prop) — no version exists until the executed
//   call appends its canonical block, so the draft is all the panel has while
//   the arguments stream.
//
// The tests mount the panel the way ChatWindow does and drive the same state
// transitions a turn produces.

beforeEach(async () => {
	sidePane.reset();
	await browserPage.viewport(1280, 800);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	sidePane.reset();
});

const emptyFileRegistry: FileArtifactRegistry = { artifacts: new Map() };

const pageOverrides = {
	route: { id: "/conversation/[id]" },
	params: { id: "conv123456" },
	data: {},
};

function version(
	overrides: Partial<ArtifactVersion> & { type: ArtifactVersion["type"] }
): ArtifactVersion {
	return {
		identifier: overrides.identifier ?? "app",
		type: overrides.type,
		title: overrides.title ?? "App",
		language: overrides.language,
		content: overrides.content ?? "",
		complete: overrides.complete ?? true,
		interrupted: overrides.interrupted,
		op: overrides.op ?? "create",
		version: overrides.version ?? 1,
		messageId: overrides.messageId ?? "m1",
		failedPairs: overrides.failedPairs,
	};
}

function registryWith(v: ArtifactVersion): ArtifactRegistry {
	return {
		artifacts: new Map([[v.identifier, { identifier: v.identifier, versions: [v] }]]),
		byMessageOp: new Map(),
		streaming: undefined,
	};
}

interface PanelProps {
	registry?: ArtifactRegistry;
	drafts?: MessageArtifactDraftUpdate[];
	loading?: boolean;
}

function mountPanel(props: PanelProps = {}) {
	return renderWithApp(
		ArtifactPanel,
		{
			registry: props.registry ?? { artifacts: new Map(), byMessageOp: new Map() },
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: props.loading ?? false,
			drafts: props.drafts ?? [],
		},
		{ page: pageOverrides }
	);
}

const body = (screen: { baseElement: HTMLElement }) => screen.baseElement;

/** The markdown preview renders through the worker pool; under load that takes
 * a moment, so every heading wait gets a generous budget (CI runs slower). */
async function previewHeading(
	screen: {
		getByRole: (role: string, options: Record<string, unknown>) => { element(): Element | null };
	},
	name: string
) {
	await vi.waitFor(
		() => expect(screen.getByRole("heading", { level: 1, name }).element()).toBeTruthy(),
		{ timeout: 10_000 }
	);
}

const codeText = (root: HTMLElement): string => root.querySelector("pre code")?.textContent ?? "";

const previewSrcdoc = (root: HTMLElement): string | null =>
	root.querySelector("iframe")?.getAttribute("srcdoc") ?? null;

/** Flush Svelte effects and any timers due within `ms` of mocked time. */
async function advance(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
}

describe("inline artifacts: the tab follows completion", () => {
	it("a react version shows code while streaming and previews once its content completes", async () => {
		const source = "export default () => <p>Hi</p>";
		sidePane.openArtifact("app");
		const screen = mountPanel({
			registry: registryWith(
				version({ identifier: "app", type: "react", content: source, complete: false })
			),
			loading: true,
		});
		// Still streaming: the code view, and the preview tab is out of reach.
		await expect.element(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
		expect(codeText(body(screen))).toBe(source);
		expect(previewSrcdoc(body(screen))).toBeNull();

		// The closing tag arrived mid-turn: complete, so the panel switches to
		// the preview even though the turn is still running.
		await screen.rerender({
			registry: registryWith(
				version({ identifier: "app", type: "react", content: source, complete: true })
			),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		await expect.element(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
		await vi.waitFor(() => expect(previewSrcdoc(body(screen))).not.toBeNull());
		expect(previewSrcdoc(body(screen))).toContain("artifact-root");
	});

	it("stays on the code tab when the user picked it, even after completion", async () => {
		const source = "export default () => <p>Hi</p>";
		sidePane.openArtifact("app");
		sidePane.selectTab("code");
		const screen = mountPanel({
			registry: registryWith(
				version({ identifier: "app", type: "react", content: source, complete: false })
			),
			loading: true,
		});
		expect(codeText(body(screen))).toBe(source);
		await screen.rerender({
			registry: registryWith(
				version({ identifier: "app", type: "react", content: source, complete: true })
			),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		// The user's choice wins over the completion flip; the tab is reachable again.
		await expect.element(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
		expect(codeText(body(screen))).toBe(source);
		expect(previewSrcdoc(body(screen))).toBeNull();
	});

	it("a markdown version already previews while it streams", async () => {
		sidePane.openArtifact("notes");
		const screen = mountPanel({
			registry: registryWith(
				version({
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# Draft",
					complete: false,
				})
			),
			loading: true,
		});
		// The live preview is the default tab while a previewable version streams.
		await previewHeading(screen, "Draft");
		expect(codeText(body(screen))).toBe("");
	});
});

describe("inline artifacts: the live preview is throttled", () => {
	it("an svg version re-renders at most about once a second while streaming", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		sidePane.openArtifact("pic");
		const props = (content: string) => ({
			registry: registryWith(version({ identifier: "pic", type: "svg", content, complete: false })),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		const screen = renderWithApp(ArtifactPanel, props("<svg><circle r='1'/></svg>"), {
			page: pageOverrides,
		});
		await advance(0);
		// First paint of the version is immediate.
		expect(previewSrcdoc(body(screen))).toContain("r='1'");

		// A token 400ms later is held back by the throttle...
		await advance(400);
		await screen.rerender(props("<svg><circle r='2'/></svg>"));
		await advance(0);
		expect(previewSrcdoc(body(screen))).toContain("r='1'");

		// ...and paints on the trailing edge of the interval.
		await advance(700);
		expect(previewSrcdoc(body(screen))).toContain("r='2'");

		// The next token inside the interval waits again.
		await advance(200);
		await screen.rerender(props("<svg><circle r='3'/></svg>"));
		await advance(0);
		expect(previewSrcdoc(body(screen))).toContain("r='2'");
		await advance(900);
		expect(previewSrcdoc(body(screen))).toContain("r='3'");
	});

	it("an html version re-renders only after the stream pauses, and never mid-script", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		sidePane.openArtifact("page");
		const props = (content: string) => ({
			registry: registryWith(
				version({ identifier: "page", type: "html", content, complete: false })
			),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		const screen = renderWithApp(ArtifactPanel, props("<h1>Hi</h1>"), { page: pageOverrides });
		await advance(0);
		// First paint (no script in the skeleton yet).
		expect(previewSrcdoc(body(screen))).toContain("<h1>Hi</h1>");

		// Tokens arriving every 300ms keep rescheduling the debounce: no reload.
		for (let i = 1; i <= 3; i += 1) {
			await advance(300);
			await screen.rerender(props(`<h1>Hi</h1><p>${i}</p>`));
		}
		await advance(0);
		expect(previewSrcdoc(body(screen))).toContain("<h1>Hi</h1>");
		expect(previewSrcdoc(body(screen))).not.toContain("<p>3</p>");

		// The stream pauses a second: the pause commits the latest content.
		await advance(1000);
		expect(previewSrcdoc(body(screen))).toContain("<p>3</p>");

		// A mid-script pause is held: the unterminated <script> must not run.
		await advance(300);
		await screen.rerender(props("<h1>Hi</h1><script>var x = 1;"));
		await advance(0);
		await advance(1500);
		expect(previewSrcdoc(body(screen))).not.toContain("var x = 1");

		// Completion always paints, script balanced or not.
		await screen.rerender({
			registry: registryWith(
				version({
					identifier: "page",
					type: "html",
					content: "<h1>Hi</h1><script>var x = 1;",
					complete: true,
				})
			),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		await advance(0);
		expect(previewSrcdoc(body(screen))).toContain("var x = 1");
	});
});

describe("tool-mode drafts", () => {
	const draft = (
		overrides: Partial<MessageArtifactDraftUpdate> & { content: string }
	): MessageArtifactDraftUpdate => ({
		type: MessageUpdateType.ArtifactDraft,
		toolCallId: overrides.toolCallId ?? "call-1",
		command: overrides.command ?? "create",
		identifier: overrides.identifier ?? "sales",
		artifactType: overrides.artifactType,
		title: overrides.title,
		content: overrides.content,
		contentComplete: overrides.contentComplete,
	});

	it("a table draft shows code while its arguments stream and previews once they complete", async () => {
		sidePane.openArtifact("sales");
		const screen = mountPanel({
			loading: true,
			drafts: [draft({ artifactType: "table", title: "Sales", content: "month,amount" })],
		});
		await expect.element(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
		expect(codeText(body(screen))).toBe("month,amount");

		// The arguments finished (the closing quote streamed in) before the call
		// executed: the preview shows the draft's complete content.
		await screen.rerender({
			registry: { artifacts: new Map(), byMessageOp: new Map() },
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [
				draft({
					artifactType: "table",
					title: "Sales",
					content: "month,amount\njan,10",
					contentComplete: true,
				}),
			],
		});
		await vi.waitFor(() => expect(body(screen).querySelector("table")).not.toBeNull());
	});

	it("a markdown draft already previews while its arguments stream", async () => {
		sidePane.openArtifact("notes");
		const screen = mountPanel({
			loading: true,
			drafts: [draft({ identifier: "notes", artifactType: "markdown", content: "# Draft" })],
		});
		await previewHeading(screen, "Draft");
		// The draft handover to the executed call's canonical block keeps the
		// same content, so the preview carries over without a reload.
		await screen.rerender({
			registry: registryWith(
				version({
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# Draft",
					complete: true,
				})
			),
			fileRegistry: emptyFileRegistry,
			items: [],
			loading: true,
			drafts: [],
		});
		await previewHeading(screen, "Draft");
	});

	it("a code draft never previews, however complete its arguments are", async () => {
		sidePane.openArtifact("script");
		const screen = mountPanel({
			loading: true,
			drafts: [
				draft({
					identifier: "script",
					artifactType: "code",
					content: "print('hi')",
					contentComplete: true,
				}),
			],
		});
		expect(codeText(body(screen))).toBe("print('hi')");
		expect(previewSrcdoc(body(screen))).toBeNull();
	});
});

describe("interrupted artifacts", () => {
	it("an interrupted version is not live: no generating shimmer, preview from its partial content", async () => {
		sidePane.openArtifact("notes");
		const screen = mountPanel({
			registry: registryWith(
				version({
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# Half a document",
					complete: true,
					interrupted: true,
				})
			),
		});
		await previewHeading(screen, "Half a document");
		expect(body(screen).textContent).not.toContain("Generating");
	});

	it("the inline card still reports the interruption", async () => {
		const v = version({
			identifier: "notes",
			type: "markdown",
			title: "Notes",
			content: "# Half",
			complete: true,
			interrupted: true,
		});
		const registry = registryWith(v);
		registry.byMessageOp.set(artifactOpKey("m1", 0), { identifier: "notes", version: 1 });
		const screen = renderWithApp(
			ArtifactCard,
			{
				op: {
					kind: "create",
					identifier: "notes",
					type: "markdown",
					title: "Notes",
					content: "# Half",
					closed: false,
				},
				messageId: "m1",
				opIndex: 0,
			},
			{
				artifacts: {
					registry,
					fileRegistry: emptyFileRegistry,
					panel: sidePane,
					requestFix: undefined,
				},
			}
		);
		await expect.element(screen.getByText("Interrupted · Document")).toBeVisible();
	});
});
