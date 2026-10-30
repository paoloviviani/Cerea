import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import type { Conversation } from "$lib/types/Conversation";
import { CONV_NUM_PER_PAGE, MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";
import { deleteConversationStorage } from "$lib/server/conversationStorage";
import { titleSearchPattern } from "$lib/server/titleSearch";
import {
	buildSnippet,
	hasWholeWord,
	textSearchString,
	SNIPPET_MESSAGES,
	SNIPPET_MESSAGE_CHARS,
} from "$lib/server/contentSearch";

type Row = Pick<Conversation, "_id" | "title" | "updatedAt" | "model" | "projectId">;

const LIST_FIELDS = { title: 1, updatedAt: 1, model: 1, projectId: 1 } as const;

/** MongoDB's "no text index" (still building, or never built): content search is skipped. */
const isMissingTextIndex = (err: unknown) =>
	typeof err === "object" && err !== null && (err as { code?: number }).code === 27;

export const GET: RequestHandler = async ({ locals, url }) => {
	requireAuth(locals);

	const pageSize = CONV_NUM_PER_PAGE;
	const p = parseInt(url.searchParams.get("p") ?? "0") || 0;
	const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_TITLE_QUERY_LENGTH);

	// `q` narrows the same list for the /chats page: the caller's own
	// conversations only (the filter below is the list's own), project chats
	// included, paged as before. Case and accents are ignored.
	//
	// Two kinds of hit, one list. Titles match as you type (`titleSearchPattern`,
	// which escapes the input and caps its length), newest first. With
	// `content=1` — the client's way of saying the words are complete: the
	// input ends with a space, Enter was pressed, or typing stopped — and at
	// least one whole word (two letters or digits), and a signed-in caller (a
	// visitor has no `userId`, which the index leads with), the message text is
	// searched too, with the text index (`conversationTextIndex.ts`; `"a phrase"` and
	// `-word` as MongoDB reads them, every plain word required). Those follow the title hits, by relevance
	// and then recency, and never repeat one. A page is a slice of that
	// concatenation, so `p` and infinite scroll work as before. Content hits
	// carry a `snippet`.
	const pattern = titleSearchPattern(q);
	const auth = authCondition(locals);
	const titleFilter = pattern ? { ...auth, title: { $regex: pattern } } : auth;
	const withContent =
		!!pattern && !!locals.user && url.searchParams.get("content") === "1" && hasWholeWord(q);

	const start = p * pageSize;
	const want = pageSize + 1;

	let titleTotal: number | null = null;
	let titleRows: Row[] = [];
	if (withContent) {
		titleTotal = await collections.conversations.countDocuments(titleFilter);
	}
	if (titleTotal === null || start < titleTotal) {
		titleRows = await collections.conversations
			.find(titleFilter)
			.project<Row>(LIST_FIELDS)
			.sort({ updatedAt: -1 })
			.skip(start)
			.limit(want)
			.toArray();
	}

	type Hit = Row & { messages?: { id: string; from: string; content?: string }[] };
	let contentRows: Hit[] = [];
	if (withContent && locals.user && titleRows.length < want) {
		try {
			// Two steps, so the relevance sort only ever holds ids and scores: the
			// ranked page of ids first, then just those conversations, with their
			// messages cut to what a snippet may read.
			const ranked = await collections.conversations
				.aggregate<{ _id: Row["_id"] }>([
					{
						$match: {
							userId: locals.user._id,
							$text: { $search: textSearchString(q) },
							title: { $not: { $regex: pattern as string } },
						},
					},
					{ $project: { updatedAt: 1, score: { $meta: "textScore" } } },
					{ $sort: { score: -1, updatedAt: -1, _id: -1 } },
					{ $skip: Math.max(0, start - (titleTotal ?? 0)) },
					{ $limit: want - titleRows.length },
					{ $project: { _id: 1 } },
				])
				.toArray();
			const ids = ranked.map((r) => r._id);
			if (ids.length) {
				const docs = await collections.conversations
					.aggregate<Hit>([
						{ $match: { _id: { $in: ids }, userId: locals.user._id } },
						{
							$project: {
								...LIST_FIELDS,
								messages: {
									$map: {
										input: { $slice: ["$messages", SNIPPET_MESSAGES] },
										as: "m",
										in: {
											id: "$$m.id",
											from: "$$m.from",
											content: {
												$substrCP: [{ $ifNull: ["$$m.content", ""] }, 0, SNIPPET_MESSAGE_CHARS],
											},
										},
									},
								},
							},
						},
					])
					.toArray();
				const byId = new Map(docs.map((d) => [String(d._id), d]));
				contentRows = ids.flatMap((id) => byId.get(String(id)) ?? []);
			}
		} catch (err) {
			if (!isMissingTextIndex(err)) throw err;
		}
	}

	const convs: Hit[] = [...titleRows, ...contentRows];
	const hasMore = convs.length > pageSize;
	const res = (hasMore ? convs.slice(0, pageSize) : convs).map((conv) => {
		const snippet = conv.messages ? buildSnippet(conv.messages, q) : undefined;
		return {
			_id: conv._id,
			id: conv._id, // legacy param iOS
			title: conv.title,
			updatedAt: conv.updatedAt,
			model: conv.model,
			modelId: conv.model, // legacy param iOS
			// A string, not an ObjectId: the sidebar compares it against ids the
			// projects API returns, and those are strings.
			...(conv.projectId ? { projectId: conv.projectId.toString() } : {}),
			...(snippet ? { snippet } : {}),
		};
	});

	return superjsonResponse({ conversations: res, hasMore });
};

export const DELETE: RequestHandler = async ({ locals }) => {
	requireAuth(locals);

	// Every conversation of the caller's, project chats included, as the v1
	// route has always done: "delete all" that left some behind, attachments
	// and indexed transcripts with them, would not mean what it says. The
	// dialog says so (`DeleteAllConversationsModal`).
	const filter = { ...authCondition(locals) };
	const ids = await collections.conversations
		.find(filter)
		.project<{ _id: Conversation["_id"] }>({ _id: 1 })
		.toArray();
	const res = await collections.conversations.deleteMany(filter);
	await deleteConversationStorage(ids.map((c) => c._id));

	return superjsonResponse(res.deletedCount);
};
