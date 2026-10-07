import type { ConvSidebar } from "$lib/types/ConvSidebar";
import { useAPIClient, handleResponse } from "$lib/APIClient";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import type { GETModelsResponse, FeatureFlags } from "$lib/server/api/types";
import { base } from "$app/paths";
import type { CustomModelView } from "$lib/types/CustomModel";
import { customModelEntries } from "$lib/utils/customModelEntries";

interface ConversationListItem {
	_id: { toString(): string };
	title: string;
	updatedAt: Date | string;
	model?: string;
	mlAssistant?: boolean;
	projectId?: string;
}

interface UserInfo {
	id: string;
	username?: string;
	avatarUrl?: string;
	email?: string;
	isAdmin: boolean;
	isEarlyAccess: boolean;
}

interface SettingsResponse {
	webSearchEnabled?: boolean;
	pyodidePyPiInstallEnabled?: boolean;
	memoryEnabled?: boolean;
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	mlInternOnboardingSeen: boolean;
	shareConversationsWithModelAuthors: boolean;
	activeModel: string;
	streamingMode: "raw" | "smooth";
	directPaste: boolean;
	hapticsEnabled: boolean;
	globalSystemPrompt?: string;
	multimodalOverrides: Record<string, boolean>;
	toolsOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	hidePromptExamples: Record<string, boolean>;
	providerOverrides: Record<string, string>;
	reasoningEffortOverrides: Record<string, "low" | "medium" | "high">;
	reasoningOverrides: Record<string, boolean>;
	billingOrganization?: string;
}

export const load = async ({ fetch, url, data }) => {
	const client = useAPIClient({ fetch, origin: url.origin });
	// `data` is the server load's output (+layout.server.ts): the gateway's
	// "is this person an administrator". It must be re-returned here, because
	// when a universal load exists the layout's `data` is exactly what the
	// universal load returns — a server field not forwarded here would exist
	// and be invisible at once.

	// Fetch the MCP base-server list alongside the other layout data.
	// During SSR, SvelteKit's fetch intercepts same-origin requests and serves
	// them directly from the handler — no real HTTP round-trip. The result is
	// inlined in the SSR payload so the client has it before any onMount fires,
	// allowing +layout.svelte to pre-populate the mcpServers store synchronously
	// and eliminate the mcpServersLoaded gate delay on first message.
	const [
		settings,
		catalogue,
		user,
		publicConfig,
		featureFlags,
		conversationsData,
		mcpBaseServers,
		customModels,
	] = (await Promise.all([
		client.user.settings.get().then(handleResponse),
		client.models.get().then(handleResponse),
		client.user.get().then(handleResponse),
		client["public-config"].get().then(handleResponse),
		client["feature-flags"].get().then(handleResponse),
		client.conversations.get({ query: { p: 0 } }).then(handleResponse),
		fetch(`${url.origin}${base}/api/mcp/servers`)
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []),
		// Fetched apart from the catalogue, which the browser may cache for a
		// minute: a custom model just saved must be in the very next load.
		fetch(`${url.origin}${base}/api/v2/custom-models`)
			.then((r) => (r.ok ? r.json() : { data: { models: [] } }))
			.then((body) => (body?.data?.models ?? []) as CustomModelView[])
			.catch(() => [] as CustomModelView[]),
	])) as [
		SettingsResponse,
		GETModelsResponse,
		UserInfo | null,
		Record<string, unknown>,
		FeatureFlags,
		{ conversations: ConversationListItem[]; hasMore: boolean },
		import("$lib/types/Tool").MCPServer[],
		CustomModelView[],
	];

	// The person's custom models sit after the catalogue (so the first entry
	// stays the deployment default), each carrying its base's capabilities.
	const models = [...catalogue, ...customModelEntries(customModels, catalogue)];
	const defaultModel = catalogue[0];

	const { conversations: rawConversations } = conversationsData;
	const conversations = rawConversations.map((conv: ConversationListItem) => {
		const trimmedTitle = conv.title.trim();

		conv.title = trimmedTitle;

		return {
			id: conv._id.toString(),
			title: conv.title,
			model: conv.model ?? defaultModel?.id,
			updatedAt: new Date(conv.updatedAt),
			mlAssistant: conv.mlAssistant ?? false,
			...(conv.projectId ? { projectId: conv.projectId } : {}),
		} satisfies ConvSidebar;
	});

	return {
		conversations,
		models,
		customModels,
		oldModels: [],
		user,
		gatewayIsAdmin: data.gatewayIsAdmin,
		webSearchAvailable: data.webSearchAvailable,
		codeFilesEnabled: data.codeFilesEnabled,
		codeTerminalEnabled: data.codeTerminalEnabled,
		settings: {
			...settings,
			welcomeModalSeenAt: settings.welcomeModalSeenAt
				? new Date(settings.welcomeModalSeenAt)
				: null,
		},
		publicConfig: getConfigManager(publicConfig as Record<`PUBLIC_${string}`, string>),
		mcpBaseServers,
		...featureFlags,
	};
};
