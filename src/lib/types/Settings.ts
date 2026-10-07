import { defaultModel } from "$lib/server/models";
import type { Accent, Neutral } from "$lib/utils/palettes";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export type StreamingMode = "raw" | "smooth";
export type ReasoningEffort = "low" | "medium" | "high";

export interface Settings extends Timestamps {
	userId?: User["_id"];
	sessionId?: string;

	shareConversationsWithModelAuthors: boolean;
	/** One-time welcome modal acknowledgement */
	welcomeModalSeenAt?: Date | null;
	/** One-time ML Intern onboarding modal acknowledgement */
	mlInternOnboardingSeenAt?: Date | null;
	activeModel: string;

	// model name and system prompts
	customPrompts?: Record<string, string>;

	/**
	 * Per-model toggle to enable/disable the custom system prompt
	 * without deleting its contents. Defaults to `true` (enabled).
	 */
	customPromptsEnabled?: Record<string, boolean>;

	/**
	 * Per‑model overrides to enable multimodal (image) support
	 * even when not advertised by the provider/model list.
	 * Only the `true` value is meaningful (enables images).
	 */
	multimodalOverrides?: Record<string, boolean>;

	/**
	 * Per‑model overrides to enable tool calling (OpenAI tools/function calling)
	 * even when not advertised by the provider list. Only `true` is meaningful.
	 */
	toolsOverrides?: Record<string, boolean>;

	/**
	 * Per-model artifacts toggle. Overrides the model's `supportsArtifacts`
	 * config flag in both directions: `true` enables artifacts on an unflagged
	 * model, `false` disables them on a flagged one.
	 */
	artifactsOverrides?: Record<string, boolean>;

	/**
	 * Web search through the gateway's own backends (`POST /v1/search`,
	 * ADR 0058's plan phase 2). Off by default: turning it on is the user's
	 * decision to spend, and the tool it enables only exists when the
	 * console has granted a `kind: "search"` tier — the toggle expresses
	 * intent, the tier is the permission.
	 */
	webSearchEnabled?: boolean;

	/**
	 * The one global policy for model-initiated tool calls with external
	 * reach or side effects (ADR 0075): today that's `web_fetch` and MCP
	 * tools. Web search carries its own explicit button; `execute_code` runs
	 * client-side in the person's own browser. Absent (the default) is
	 * `manual`.
	 *
	 * - `"always-allow"`: gated calls run without asking.
	 * - `"manual"`: every gated call parks on an approval card (accept once /
	 *   accept for the conversation / deny the call). Conversation-lifetime
	 *   grants accumulate per tool on `Conversation.approvedTools`.
	 *
	 * Overridable per chat at the composer; per call the resolution is chat
	 * override, else this setting, else `manual`.
	 */
	toolApprovalPolicy?: "always-allow" | "manual";

	/**
	 * User opt-in (default off) to let the code sandbox's micropip fetch
	 * arbitrary pure-Python packages from the public PyPI index, in addition
	 * to the vendored wheels every deployment serves same-origin. Off means
	 * micropip never reaches beyond this origin — no third-party egress. An
	 * admin kill-switch (`CHAT_PYODIDE_PYPI_DISABLED`) can force this off
	 * deployment-wide regardless of the stored value; see
	 * `FeatureFlags.pyodidePyPiInstallAllowed`, which reports whether the
	 * switch is even available to opt into.
	 */
	pyodidePyPiInstallEnabled?: boolean;

	/**
	 * Whether standing personal facts are kept and carried into every
	 * conversation (see `$lib/types/Memory`). Off by default and stored as
	 * absent, the same judgement `Project.indexPastChats` makes: memory
	 * writes things somebody said into a store that outlives the
	 * conversation, and that is a decision worth making rather than
	 * discovering.
	 *
	 * Governs both halves at once — with it off nothing is injected into the
	 * prompt and the `remember`/`forget` tools are not offered — so turning
	 * it off is a full stop rather than a pause with a tool still writing.
	 * Stored facts survive it, because a switch that deleted them would make
	 * "let me try this off for a week" an irreversible act; the Memory screen
	 * is where deleting happens.
	 *
	 * The deployment's `CHAT_MEMORY_ENABLED` can withdraw the feature
	 * entirely regardless of this value (`FeatureFlags.memoryEnabled`).
	 */
	memoryEnabled?: boolean;

	/**
	 * Per-model toggle to hide Omni prompt suggestions shown near the composer.
	 * When set to `true`, prompt examples for that model are suppressed.
	 */
	hidePromptExamples?: Record<string, boolean>;

	/**
	 * Per-model inference provider preference.
	 * Values: "auto" (default), "fastest", "cheapest", or a specific provider name (e.g., "together", "sambanova").
	 * The value is appended to the model ID when making inference requests (e.g., "model:fastest").
	 */
	providerOverrides?: Record<string, string>;

	/**
	 * Per-model thinking effort. Sent as `reasoning_effort` to the OpenAI-compatible
	 * endpoint when set; omitted (provider default) when missing.
	 */
	reasoningEffortOverrides?: Record<string, ReasoningEffort>;

	/**
	 * Per-model override for whether the Reasoning-effort UI should appear and
	 * `reasoning_effort` should be forwarded. Falls back to `model.supportsReasoning`.
	 */
	reasoningOverrides?: Record<string, boolean>;

	/**
	 * Preferred assistant output behavior in the chat UI.
	 * - "raw": show provider-native stream chunks
	 * - "smooth": show smoothed stream chunks
	 */
	streamingMode: StreamingMode;
	directPaste: boolean;

	/**
	 * Whether haptic feedback is enabled on supported touch devices.
	 * Uses the ios-haptics library for cross-platform vibration.
	 */
	hapticsEnabled: boolean;

	/**
	 * The person's colour choices (Settings → Appearance), applied as
	 * `data-accent` / `data-neutral` on `<html>` — see `$lib/utils/palettes`.
	 * Absent means the default (blue, gray). Stored on the account, not in
	 * the browser, so they follow the person across devices.
	 */
	accent?: Accent;
	neutral?: Neutral;

	/**
	 * Organization to bill inference requests to (HuggingChat only).
	 * Stores the org's preferred_username. If empty/undefined, bills to personal account.
	 */
	billingOrganization?: string;
}

export type SettingsEditable = Omit<
	Settings,
	"welcomeModalSeenAt" | "mlInternOnboardingSeenAt" | "createdAt" | "updatedAt"
>;
// TODO: move this to a constant file along with other constants
export const DEFAULT_SETTINGS = {
	shareConversationsWithModelAuthors: true,
	// defaultModel is unset during `vite build` (models aren't fetched at build time)
	activeModel: defaultModel?.id ?? "",
	customPrompts: {},
	customPromptsEnabled: {},
	multimodalOverrides: {},
	toolsOverrides: {},
	artifactsOverrides: {},
	hidePromptExamples: {},
	providerOverrides: {},
	reasoningEffortOverrides: {},
	reasoningOverrides: {},
	streamingMode: "smooth",
	directPaste: false,
	hapticsEnabled: true,
	accent: "blue",
	neutral: "gray",
} satisfies SettingsEditable;
