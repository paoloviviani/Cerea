/**
 * The pure parts of the model/effort pill (`ModelEffortPicker.svelte`): the
 * short list, search, effort labels, and the remembered recent picks.
 */

export interface PickerModel {
	id: string;
	name: string;
	description?: string;
}

export const SHORT_LIST_MAX = 6;
export const RECENT_MODELS_KEY = "chat.recentModels";

/**
 * With no query: the current model first, then recent picks still offered,
 * up to six. With a query: every model whose id, name or description holds
 * all the query's words, current first.
 */
export function shortList(
	models: PickerModel[],
	currentId: string,
	recentIds: string[],
	query: string
): PickerModel[] {
	const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const byId = new Map(models.map((m) => [m.id, m]));
	if (words.length > 0) {
		const hits = models.filter((m) => {
			const hay = `${m.id} ${m.name} ${m.description ?? ""}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
		return hits.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
	}
	const ids = [currentId, ...recentIds.filter((id) => id !== currentId)];
	const out: PickerModel[] = [];
	for (const id of ids) {
		const model = byId.get(id);
		if (model && !out.includes(model)) out.push(model);
		if (out.length >= SHORT_LIST_MAX) break;
	}
	return out;
}

/** "Default" for no explicit effort, else the level, capitalised. */
export function effortLabel(effort: string | undefined | null): string {
	if (!effort) return "Default";
	return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The recent list after picking `id`: most recent first, de-duplicated. */
export function withRecent(recentIds: string[], id: string): string[] {
	return [id, ...recentIds.filter((r) => r !== id)].slice(0, SHORT_LIST_MAX);
}

export function readRecent(storage: Pick<Storage, "getItem"> | undefined): string[] {
	try {
		const raw = storage?.getItem(RECENT_MODELS_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The chat effort in force: the conversation's own, else the user's
 * per-model default; undefined means the model's own default. A preset that
 * pins effort wins over both.
 */
export function chatEffort(input: {
	preset?: string;
	conversation?: string;
	userDefault?: string;
}): string | undefined {
	return input.preset ?? input.conversation ?? input.userDefault;
}
