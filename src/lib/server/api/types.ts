import type { BackendModel } from "$lib/server/models";

// List shape: intentionally excludes `providers` (~60KB across all models) and
// `parameters` — no list consumer reads them, and the whole list is SSR-inlined
// into every page. They are served by the per-model detail endpoint instead.
export type GETModelsResponse = Array<{
	id: string;
	name: string;
	websiteUrl?: string;
	modelUrl?: string;
	datasetName?: string;
	datasetUrl?: string;
	displayName: string;
	description?: string;
	logoUrl?: string;
	promptExamples?: { title: string; prompt: string }[];
	preprompt?: string;
	multimodal: boolean;
	multimodalAcceptedMimetypes?: string[];
	supportsTools: boolean;
	supportsReasoning: boolean;
	supportsArtifacts: boolean;
	unlisted: boolean;
	hasInferenceAPI: boolean;
	isRouter: boolean;
}>;

export type GETModelResponse = GETModelsResponse[number] & {
	providers?: Array<{ provider: string } & Record<string, unknown>>;
	parameters: BackendModel["parameters"];
};

export type GETOldModelsResponse = Array<{
	id: string;
	name: string;
	displayName: string;
	transferTo?: string;
}>;

export interface FeatureFlags {
	enableAssistants: boolean;
	loginEnabled: boolean;
	isAdmin: boolean;
	transcriptionEnabled: boolean;
	/** Fixed model used for background tasks (e.g. conversation titles); null when tasks follow the conversation's model */
	taskModelId: string | null;
	/** Models ML Intern conversations may use, in order; the first is the default. Empty when the mode is off. */
	mlAssistantModels: string[];
	/**
	 * Whether the deployment allows the "install packages from PyPI" code
	 * sandbox setting at all — false when the admin kill-switch
	 * (`CHAT_PYODIDE_PYPI_DISABLED`) is set, regardless of what any user has
	 * stored. The user's own `pyodidePyPiInstallEnabled` setting is the
	 * separate opt-in; both must be true for the sandbox to actually reach
	 * PyPI.
	 */
	pyodidePyPiInstallAllowed: boolean;
	/**
	 * Whether the deployment exposes the Usage & billing settings tab
	 * (`CHAT_USAGE_ENABLED`). Off by default: a deployment without Pystino has
	 * no gateway to read quotas or spend from, and this flag is what keeps it
	 * from depending on one. The billing-group selector moved into that same
	 * tab and is gated on this flag too — both are gateway concepts (ADR
	 * 0061), so hiding one without the other would orphan a control nobody
	 * asked for.
	 */
	usageEnabled: boolean;
	/**
	 * Whether the deployment runs the knowledge pipeline
	 * (`CHAT_KNOWLEDGE_ENABLED`, on unless explicitly `"false"`). Off hides
	 * the Knowledge workspace tab, the project and composer affordances, and
	 * the admin section — a deployment without the chat's Postgres has no
	 * store behind them, and a tab that only errors is worse than none.
	 */
	knowledgeEnabled: boolean;
	/**
	 * Whether the deployment keeps standing personal facts
	 * (`CHAT_MEMORY_ENABLED`, on unless explicitly `"false"`). Off hides the
	 * Memory workspace tab and refuses its routes, and the `remember`/`forget`
	 * tools are never offered. Each person's own `Settings.memoryEnabled` is
	 * the separate opt-in, and defaults off — both must be true before
	 * anything is stored or injected.
	 */
	memoryEnabled: boolean;
	/**
	 * Whether this origin serves the Pystino console at /console
	 * (`CHAT_CONSOLE_ENABLED`). On means the gateway profiles (homelab, team,
	 * enterprise): the chat's admin panel links to the console for the
	 * platform side — providers, models, prices, quotas, users. Off means the
	 * standalone profiles: satellite's Pystino is central's and its console
	 * is not this origin's to serve, generic has no Pystino at all — a link
	 * to an unserved /console would be a 404 wearing the name of a feature.
	 */
	consoleEnabled: boolean;
	/**
	 * Whether the deployment exposes the `/code` remote-agent panel
	 * (`CODE_AGENTS_ENABLED`, off unless explicitly `"true"`). Off hides the
	 * sidebar row and the route answers 404.
	 */
	codeAgentsEnabled: boolean;
	/**
	 * The chat's own OIDC issuer (`OPENID_PROVIDER_URL`) — the bundled
	 * Authelia or whatever external IdP the deployment points at: the
	 * `--issuer` a machine's `galopin enroll` needs, so its OIDC lands on
	 * the provider that actually issued the deployment's tokens, rather than a
	 * path only the bundled Authelia serves.
	 */
	codeOidcIssuerUrl: string;
	/**
	 * The enrollment CLI's OAuth client id (`CODE_MACHINE_CLIENT_ID`, default
	 * `opencode-enrollment`) — the pairing dialog's one-liner only prints
	 * `--client-id` when a deployment has overridden it.
	 */
	codeOidcClientId: string;
	/**
	 * The gateway origin (or `/v1` base) `galopin enroll --gateway` needs
	 * (`CODE_GATEWAY_ORIGIN`). Empty on a deployment that hasn't set one; the
	 * dialog falls back to the browser's own origin rather than this
	 * endpoint guessing at a gateway address.
	 */
	codeGatewayOrigin: string;
}
