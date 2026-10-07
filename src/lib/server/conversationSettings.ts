import type { Filter, UpdateResult } from "mongodb";
import { error } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { isMlAssistantConversation } from "$lib/server/mlAssistant";
import { mlAssistantModelIds } from "$lib/server/mlAssistantModels";
import { baseModelIdFor, conversationOwnerFilter } from "$lib/server/customModels";
import { isCustomModelId } from "$lib/utils/customModelId";

/** The mutable conversation settings both PATCH endpoints expose. */
export interface ConversationSettingsUpdate {
	title?: string;
	/** This conversation's thinking effort; null clears it back to the user default. */
	reasoningEffort?: "low" | "medium" | "high" | null;
	model?: string;
	/**
	 * Knowledge bases attached to the conversation, replacing the previous
	 * list wholesale — an empty array is a real value that clears, and only
	 * an absent field leaves what is stored untouched. Callers validate the
	 * ids (shape and reach) before handing them here; the update itself is a
	 * targeted `$set` so a concurrent generation's message writes are not
	 * clobbered by a snapshot the composer took earlier.
	 */
	knowledgeBaseIds?: string[];
	/**
	 * Per-chat web-search state. Replaces the previous value wholesale;
	 * absent leaves what is stored untouched. This is the per-chat half of
	 * the defaults-vs-state split: the composer's toggle writes here, never
	 * to `Settings.webSearchEnabled`.
	 */
	webSearch?: boolean;
	/**
	 * Chat-local override of `Settings.toolApprovalPolicy` (ADR 0075).
	 * Replaces the previous value wholesale; absent leaves what is stored
	 * untouched. The composer's toggle writes here, never to the setting.
	 */
	toolApprovalOverride?: "always-allow" | "manual";
}

/**
 * Apply a title/model change, backfilling producer metadata when the pinned
 * model changes.
 *
 * Shared rather than duplicated because getting this wrong is silent: switching
 * the model means every prior assistant message was produced by the OLD model,
 * and those messages carry no `routerMetadata.model` of their own — it is only
 * ever stamped for the "omni" router alias. Without the backfill, history
 * replay's same-producer check treats them as produced by the newly selected
 * model and attaches the old model's reasoning to a turn it never produced. An
 * endpoint that changes `model` with a plain `$set` reintroduces exactly that,
 * which is what happened while only the legacy handler had the pipeline.
 *
 * Runs as an aggregation pipeline so the backfill is computed server-side from
 * the document as it exists at write time: mapping a snapshot read earlier in
 * the request and writing it back would replace the whole array, discarding
 * anything persisted in between — an in-flight generation rewrites the same
 * array on every token batch. `$model` is likewise the currently pinned model
 * rather than one read earlier, so the id stamped is always the one messages
 * were actually produced under, and the `$ne` gate means a switch that raced
 * ahead leaves history untouched instead of restamping it.
 *
 * Callers own authorization: pass a filter that already scopes to the caller.
 */
export async function applyConversationSettings(
	filter: Filter<Conversation>,
	values: ConversationSettingsUpdate
): Promise<UpdateResult> {
	const updateValues = {
		// Titles are model-generated, so they can carry think markup.
		...(values.title !== undefined && {
			title: values.title.replace(/<\/?think>/gi, "").trim(),
		}),
		...(values.model !== undefined && { model: values.model }),
		...(values.knowledgeBaseIds !== undefined && {
			knowledgeBaseIds: values.knowledgeBaseIds,
		}),
		...(values.webSearch !== undefined && { webSearch: values.webSearch }),
		...(values.toolApprovalOverride !== undefined && {
			toolApprovalOverride: values.toolApprovalOverride,
		}),
	};

	if (values.reasoningEffort === null) {
		await collections.conversations.updateOne(filter, { $unset: { reasoningEffort: "" } });
	} else if (values.reasoningEffort !== undefined) {
		Object.assign(updateValues, { reasoningEffort: values.reasoningEffort });
	}

	if (values.model === undefined) {
		return collections.conversations.updateOne(filter, { $set: updateValues });
	}

	// Here, not in the endpoints: an ML Intern conversation may only move within
	// the mode's fixed set, and a guard that lives in one handler is exactly how
	// the other one came to bypass it.
	const current = await collections.conversations.findOne(filter, {
		projection: { mlAssistant: 1, model: 1, userId: 1, sessionId: 1 },
	});
	if (
		current &&
		isMlAssistantConversation(current) &&
		!mlAssistantModelIds().includes(values.model)
	) {
		error(400, "This model is not available for ML Intern conversations");
	}

	const newModel = values.model;
	// The producer stamped on history is the model that really made it. On a
	// custom model that is the base (the custom id never reaches the upstream,
	// and replay compares against the base's id), resolved here because the
	// pipeline below cannot look a custom row up. Guarded on the stored model
	// still being the one read here, so a racing switch stamps what it found.
	const oldModel = current?.model;
	const oldBase =
		oldModel && current && isCustomModelId(oldModel)
			? await baseModelIdFor(oldModel, conversationOwnerFilter(current))
			: undefined;
	const producer = oldBase
		? { $cond: [{ $eq: ["$model", oldModel] }, oldBase, "$model"] }
		: "$model";
	return collections.conversations.updateOne(filter, [
		{
			$set: {
				messages: {
					$cond: [
						{ $ne: ["$model", newModel] },
						{
							$map: {
								input: "$messages",
								as: "m",
								in: {
									$cond: [
										{
											$and: [
												{ $eq: ["$$m.from", "assistant"] },
												// No producer of its own — see the note above.
												{ $eq: [{ $ifNull: ["$$m.routerMetadata.model", ""] }, ""] },
											],
										},
										{
											$mergeObjects: [
												"$$m",
												{
													// Merged rather than replaced so an existing `route` or
													// `provider` survives; `route` is required by the type,
													// hence the default underneath.
													routerMetadata: {
														$mergeObjects: [
															{ route: "" },
															{ $ifNull: ["$$m.routerMetadata", {}] },
															{ model: producer },
														],
													},
												},
											],
										},
										"$$m",
									],
								},
							},
						},
						"$messages",
					],
				},
			},
		},
		// Separate stage: within one `$set` every expression sees the input
		// document, so the backfill above must resolve `$model` before this
		// overwrites it.
		{ $set: updateValues },
	]);
}
