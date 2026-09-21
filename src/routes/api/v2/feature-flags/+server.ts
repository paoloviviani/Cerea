import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { loginEnabled } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import type { FeatureFlags } from "$lib/server/api/types";
import { mlAssistantModelIds } from "$lib/server/mlAssistantModels";

export const GET: RequestHandler = async ({ locals }) => {
	// Mirror the title-generation resolution (generateFromDefaultEndpoint): the
	// live TASK_MODEL value wins over the startup-resolved task model, so the
	// reported id stays correct when TASK_MODEL changes via the config manager.
	// With LLM_SUMMARIZATION off, titles never invoke a model, so report none.
	let taskModelId: string | null = null;
	const configuredTaskModel = config.TASK_MODEL;
	if (config.LLM_SUMMARIZATION === "true" && configuredTaskModel?.trim()) {
		try {
			const { models, taskModel } = await import("$lib/server/models");
			taskModelId = (models.find((m) => m.id === configuredTaskModel) ?? taskModel)?.id ?? null;
		} catch {
			taskModelId = null;
		}
	}

	return superjsonResponse({
		enableAssistants: config.ENABLE_ASSISTANTS === "true",
		loginEnabled,
		isAdmin: locals.isAdmin,
		transcriptionEnabled: !!config.get("TRANSCRIPTION_MODEL"),
		taskModelId,
		mlAssistantModels: mlAssistantModelIds(),
		pyodidePyPiInstallAllowed: config.CHAT_PYODIDE_PYPI_DISABLED !== "true",
		// Also requires a configured gateway (mirrored in pystinoProvider.ts's
		// own isEnabled): a flag with no OPENAI_BASE_URL would show a tab whose
		// only provider can never answer.
		usageEnabled: config.CHAT_USAGE_ENABLED === "true" && !!config.OPENAI_BASE_URL,
		knowledgeEnabled: knowledgeEnabled(),
		memoryEnabled: memoryEnabled(),
		// A deployment fact, not a product toggle: the gateway profiles
		// serve /console on this origin and the admin panel may link to it;
		// the standalone profiles do not (satellite's console is central's,
		// generic has none).
		consoleEnabled: config.CHAT_CONSOLE_ENABLED === "true",
	} satisfies FeatureFlags);
};
