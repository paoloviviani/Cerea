import { config } from "$lib/server/config";

/**
 * The deployment switch for sub-agents (`CHAT_DELEGATION`): the `delegate` tool
 * and the `research` preset.
 *
 * On unless explicitly `"false"`, like memory and the question tool: existing
 * deployments never set the variable, and a feature that turns itself off
 * everywhere is one nobody finds. An administrator turns it off under
 * Administration -> Sub-agents when sub-agents' extra model calls, or the
 * connector tools they use without the person watching each step, are not
 * wanted on this deployment.
 */
export function delegationEnabled(): boolean {
	return config.CHAT_DELEGATION !== "false";
}

/** A model a person may pick for a sub-agent, as `delegate` validates against. */
export interface DelegationModel {
	id: string;
	name: string;
	contextLength?: number;
	maxTokens?: number;
}

/**
 * The models this person may pick for a sub-agent: what the models list shows
 * them (`visibleModels`, which the gateway filters by their own token), that
 * can call tools, and are real catalogue models: never a
 * custom model. The gateway stays the authority at call time; this decides
 * what `delegate` accepts and names to the model. A failure to read the
 * catalogue means no choice is offered (the sub-agent uses the conversation's
 * model), never a failed turn.
 */
export async function delegationModelsFor(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user"> | undefined
): Promise<DelegationModel[]> {
	if (!locals) return [];
	try {
		const { visibleModels } = await import("$lib/server/visibleModels");
		return (await visibleModels(locals))
			.filter((model) => model.supportsTools && !model.id.startsWith("custom:"))
			.map((model) => {
				const maxTokens = (model.parameters as { max_tokens?: unknown } | undefined)?.max_tokens;
				return {
					id: model.id,
					name: model.displayName || model.id,
					...(model.contextLength ? { contextLength: model.contextLength } : {}),
					...(typeof maxTokens === "number" ? { maxTokens } : {}),
				};
			});
	} catch {
		return [];
	}
}
