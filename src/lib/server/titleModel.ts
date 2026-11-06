import { config } from "$lib/server/config";

/** The slice of a catalogue model that choosing a title model needs. */
export interface TitleModelCandidate {
	id: string;
	name?: string;
	supportsReasoning?: boolean;
	unlisted?: boolean;
}

/** The model the administrator picked for titles, or null for "automatic". */
export function storedTitleModel(): string | null {
	// A saved value wins even when empty (choosing "automatic" sticks).
	const raw = config.getSaved("TITLE_MODEL") ?? config.TITLE_MODEL ?? "";
	return raw.trim() || null;
}

const matches = (m: TitleModelCandidate, ref: string) => m.id === ref || m.name === ref;

/**
 * Which model writes a chat's title.
 *
 *  1. The administrator's choice (Administration -> Assistant), when the
 *     catalogue still lists it.
 *  2. `TASK_MODEL`, when set.
 *  3. Automatic: the conversation's own model when it does not reason, else
 *     the first listed model that does not, else the conversation's model.
 *     A reasoning model spends the small title budget thinking and returns
 *     nothing, which is what left chats with their first five words.
 *
 * `convModel` is the conversation's model with a custom id already resolved to
 * its base: the gateway has never heard of the custom id.
 */
export function pickTitleModel(args: {
	stored: string | null;
	env: string | undefined;
	convModel: string;
	catalogue: TitleModelCandidate[];
}): string {
	const { stored, env, convModel, catalogue } = args;
	if (stored) {
		const chosen = catalogue.find((m) => matches(m, stored));
		if (chosen) return chosen.id;
	}
	if (env?.trim()) return env;
	const own = catalogue.find((m) => matches(m, convModel));
	if (own && !own.supportsReasoning) return convModel;
	const plain = catalogue.find((m) => !m.supportsReasoning && !m.unlisted);
	return plain?.id ?? convModel;
}
