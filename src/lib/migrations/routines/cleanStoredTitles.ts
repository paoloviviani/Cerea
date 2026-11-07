import { ObjectId } from "mongodb";
import type { Collection } from "mongodb";
import type { Conversation } from "$lib/types/Conversation";
import { sanitiseTitle } from "$lib/server/textGeneration/titleSanitize";
import { fallbackTitle } from "$lib/server/textGeneration/titleFallback";

export const MIGRATION_CLEAN_STORED_TITLES = new ObjectId("6a0c1d4f2b8e4c3a9d5f7e61");

/** A model's control token left in a title, e.g. `<|start|>assistant<|channel|>`. */
const CONTROL_TOKEN = /<\|[^|>]*\|>/;

/**
 * Titles made before the sanitiser existed carry model tokens, refusals and
 * answers in the wrong language. This applies the same sanitiser to the ones
 * that match those patterns, and nothing else: a title the user typed
 * (`titleSource: "user"`) and a title that passes are never touched. A title
 * the sanitiser cannot repair becomes the first words of the first message.
 * Conversations with no `titleSource` predate the field and may carry a name
 * the user typed ("I can't log in" reads like a refusal), so there only a
 * control token counts as bad. Returns how many titles changed.
 */
export async function cleanStoredTitles(db: {
	conversations: Collection<Conversation>;
}): Promise<number> {
	const cursor = db.conversations.aggregate<{
		_id: ObjectId;
		title: string;
		titleSource?: Conversation["titleSource"];
		firstUser?: string;
	}>([
		{ $match: { titleSource: { $ne: "user" }, title: { $nin: ["", "New Chat"] } } },
		{
			$project: {
				title: 1,
				titleSource: 1,
				firstUser: {
					$arrayElemAt: [
						{
							$map: {
								input: {
									$filter: { input: "$messages", as: "m", cond: { $eq: ["$$m.from", "user"] } },
								},
								as: "m",
								in: "$$m.content",
							},
						},
						0,
					],
				},
			},
		},
	]);
	let changed = 0;
	for await (const row of cursor) {
		const prompt = typeof row.firstUser === "string" ? row.firstUser : "";
		const hasToken = CONTROL_TOKEN.test(row.title);
		if (!row.titleSource && !hasToken) continue;
		// Without a titleSource only the language-free checks apply.
		const repaired = sanitiseTitle(row.title, row.titleSource ? prompt : "");
		if (!hasToken && repaired !== undefined) continue;
		const title = repaired ?? fallbackTitle(prompt);
		if (title === row.title) continue;
		await db.conversations.updateOne(
			{ _id: row._id, titleSource: { $ne: "user" }, title: row.title },
			{ $set: { title, titleSource: "fallback" } }
		);
		changed += 1;
	}
	return changed;
}
