import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { artifactFileName, collectArtifacts } from "$lib/utils/artifacts";
import type { Message } from "$lib/types/Message";

/**
 * What the Artifacts tabs list (a project's, or the chats that are in no
 * project): everything the model made in the caller's chats, one row per
 * artifact, newest first. The side panel derives the same two kinds in the
 * browser, one chat at a time; this reads them across chats with one query
 * per store, never one per chat:
 *
 * - files (`codeExecutionOutputs`: Python runs, Office documents from the
 *   `doc_*` tools, conversions) — grouped by chat and name, the newest row
 *   is the latest version and the row count is the version count. The store
 *   holds only what a run or tool produced; an upload is a message
 *   attachment, which this never reads, so uploads are not listed.
 * - text artifacts (`<artifact>` tags in assistant messages) — parsed with
 *   the same `collectArtifacts` the panel uses, from the messages that
 *   mention the tag, in one aggregation.
 *
 * Scope is the caller's own chats (`owner` is their `authCondition`): in a
 * shared project a colleague's chats are never read, so their artifacts and
 * titles never leave the server.
 */

export type ArtifactListKind = "file" | "artifact";

export interface ArtifactListItem {
	kind: ArtifactListKind;
	/** The name to show: a file's name, a text artifact's latest title. */
	name: string;
	/** What the side panel opens it by: the file name, or the artifact's identifier. */
	identifier: string;
	/** A text artifact's type ("html", "markdown"...); a file's MIME type. */
	type: string;
	/** The latest version's number, and how many there are. */
	version: number;
	versionCount: number;
	conversationId: string;
	conversationTitle: string;
	at: string;
	/** Files only: for the download link and the size label. */
	sha256?: string;
	size?: number;
}

export interface ArtifactListScope {
	/** `authCondition(locals)`: the caller's own chats. */
	owner: Record<string, unknown>;
	/** A project's chats, or null for the chats that are in no project. */
	projectId: ObjectId | null;
}

const fold = (text: string) =>
	text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();

interface ChatRow {
	_id: ObjectId;
	title: string;
}

async function ownChats({ owner, projectId }: ArtifactListScope): Promise<Map<string, string>> {
	const rows = await collections.conversations
		.find({ ...owner, projectId } as never)
		.project<ChatRow>({ title: 1 })
		.toArray();
	return new Map(rows.map((row) => [String(row._id), row.title]));
}

async function fileItems(chats: Map<string, string>): Promise<ArtifactListItem[]> {
	if (chats.size === 0) return [];
	const ids = [...chats.keys()].map((id) => new ObjectId(id));
	const groups = await collections.codeExecutionOutputs
		.aggregate<{
			_id: { c: ObjectId; n: string };
			count: number;
			version?: number;
			mime: string;
			sha256: string;
			size: number;
			at: Date;
		}>(
			[
				{ $match: { conversationId: { $in: ids } } },
				// The version that is current now: a restore (`latestAt`) puts an older one back on top.
				{
					$project: {
						conversationId: 1,
						name: 1,
						version: 1,
						mime: 1,
						sha256: 1,
						size: 1,
						liveAt: { $ifNull: ["$latestAt", "$createdAt"] },
					},
				},
				{ $sort: { liveAt: -1, _id: -1 } },
				{
					$group: {
						_id: { c: "$conversationId", n: "$name" },
						count: { $sum: 1 },
						version: { $first: "$version" },
						mime: { $first: "$mime" },
						sha256: { $first: "$sha256" },
						size: { $first: "$size" },
						at: { $first: "$liveAt" },
					},
				},
			],
			{ allowDiskUse: true }
		)
		.toArray();
	return groups.map((group) => ({
		kind: "file" as const,
		name: group._id.n,
		identifier: group._id.n,
		type: group.mime,
		version: group.version ?? group.count,
		versionCount: group.count,
		conversationId: String(group._id.c),
		conversationTitle: chats.get(String(group._id.c)) ?? "",
		at: group.at.toISOString(),
		sha256: group.sha256,
		size: group.size,
	}));
}

type ArtifactMessage = Pick<Message, "id" | "from" | "content"> & { createdAt?: Date };

/** The assistant messages of the chats that mention an artifact tag, grouped by chat. */
async function artifactMessages(scope: ArtifactListScope) {
	return collections.conversations
		.aggregate<{ _id: ObjectId; title: string; updatedAt: Date; messages: ArtifactMessage[] }>([
			{
				$match: {
					...scope.owner,
					projectId: scope.projectId,
					messages: {
						$elemMatch: { from: "assistant", content: { $regex: "<+artifact\\b", $options: "i" } },
					},
				},
			},
			{
				$project: {
					title: 1,
					updatedAt: 1,
					messages: {
						$map: {
							input: {
								$filter: {
									input: "$messages",
									as: "m",
									cond: {
										$and: [
											{ $eq: ["$$m.from", "assistant"] },
											{
												$regexMatch: {
													input: { $ifNull: ["$$m.content", ""] },
													regex: "<+artifact\\b",
													options: "i",
												},
											},
										],
									},
								},
							},
							as: "m",
							in: {
								id: "$$m.id",
								from: "$$m.from",
								content: "$$m.content",
								createdAt: "$$m.createdAt",
							},
						},
					},
				},
			},
		])
		.toArray();
}

async function textItems(scope: ArtifactListScope): Promise<ArtifactListItem[]> {
	const items: ArtifactListItem[] = [];
	for (const chat of await artifactMessages(scope)) {
		const when = new Map(chat.messages.map((message) => [message.id, message.createdAt]));
		for (const artifact of collectArtifacts(chat.messages).artifacts.values()) {
			const latest = artifact.versions.at(-1);
			if (!latest) continue;
			items.push({
				kind: "artifact",
				name: latest.title,
				identifier: artifact.identifier,
				type: latest.type,
				version: latest.version,
				versionCount: artifact.versions.length,
				conversationId: String(chat._id),
				conversationTitle: chat.title,
				at: (when.get(latest.messageId) ?? chat.updatedAt).toISOString(),
			});
		}
	}
	return items;
}

export interface ArtifactListPage {
	data: ArtifactListItem[];
	hasMore: boolean;
}

/** One page of the scope's artifacts, newest first, optionally narrowed by a name filter. */
export async function listArtifacts(
	scope: ArtifactListScope,
	{ q = "", page = 0, pageSize }: { q?: string; page?: number; pageSize: number }
): Promise<ArtifactListPage> {
	const chats = await ownChats(scope);
	if (chats.size === 0) return { data: [], hasMore: false };
	const [files, texts] = await Promise.all([fileItems(chats), textItems(scope)]);
	const wanted = fold(q.trim());
	const all = [...files, ...texts]
		.filter((item) => !wanted || fold(item.name).includes(wanted))
		.sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
	const start = page * pageSize;
	return { data: all.slice(start, start + pageSize), hasMore: all.length > start + pageSize };
}

/** A text artifact's latest content as a download, from a chat of the caller's. */
export async function latestArtifactFile(
	owner: Record<string, unknown>,
	conversationId: ObjectId,
	identifier: string
): Promise<{ name: string; content: string } | undefined> {
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...owner } as never,
		{ projection: { messages: { id: 1, from: 1, content: 1 } } }
	);
	if (!conversation) return undefined;
	const latest = collectArtifacts(conversation.messages).artifacts.get(identifier)?.versions.at(-1);
	return latest ? { name: artifactFileName(latest), content: latest.content } : undefined;
}
