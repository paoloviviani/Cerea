import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageCodeExecutionOutputsUpdate,
} from "$lib/types/MessageUpdate";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import { MAX_DELIVERABLES_PER_CONVERSATION } from "$lib/server/execution/deliverables";
import { MAX_CODE_RUN_FILES_PER_CONVERSATION } from "$lib/server/execution/runFiles";

/**
 * Record a browser-started run's output files on the assistant message its
 * code belongs to — a chat code block (auto-run or Run) or an artifact cell.
 *
 * The files themselves were already uploaded through `../output` (the same
 * store, caps and 30-day TTL an `execute_code` run uses); this only records
 * which message they belong to, in `codeRunFiles`. The conversation loader
 * serves that as a `CodeExecution/Outputs` update on the message, so the file
 * artifacts, the sidebar and a replayed block all find the files after a
 * reload and on another device. That is the whole point of it: a file is kept
 * and shown the same way whichever path produced it. (A record, not a push
 * onto the message: see CodeRunFiles.ts for why.)
 *
 * Nothing the client says about a file is trusted but its hash. Each ref is
 * rebuilt from this conversation's own store row, so a request can only name
 * bytes this conversation's owner already uploaded here. Same ownership check
 * as the upload (`authCondition`): a shared-conversation viewer is not the
 * owner and is refused, so nobody writes into somebody else's chat.
 */

const body = z.object({
	messageId: z.string().min(1).max(128),
	runKey: z.string().min(1).max(512),
	sha256: z
		.array(z.string().regex(/^[0-9a-f]{64}$/))
		.min(1)
		.max(MAX_DELIVERABLES_PER_CONVERSATION),
});

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid request");
	const { messageId, runKey } = parsed.data;
	const hashes = [...new Set(parsed.data.sha256)];

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1, messages: { $elemMatch: { id: messageId } } } }
	);
	if (!conversation) error(404, "Conversation not found");
	// The message may not be saved yet: an auto-run fires as soon as its fence
	// closes, while the turn is still streaming, under the client-minted id the
	// page swaps out for the server's own once the turn's save round-trips and
	// the page re-syncs. A record made under that stale id would never be
	// served back (the loader only decorates messages that are actually on the
	// conversation), so it is refused rather than silently kept as an orphan;
	// the caller retries once its context carries the real id (see
	// runFiles.svelte.ts's release + CodeBlock/ArtifactPanel's claim key).
	const message = conversation.messages?.[0];
	if (!message) error(409, "message not saved yet");
	if (message.from !== "assistant") error(400, "Not an assistant message");

	const rows = await collections.codeExecutionOutputs
		.find({ conversationId, sha256: { $in: hashes } })
		.project<{ name: string; size: number; sha256: string }>({ name: 1, size: 1, sha256: 1 })
		.toArray();
	const bySha = new Map(rows.map((row) => [row.sha256, row]));
	// In the order the run listed them; a hash this conversation never stored is dropped.
	const files: PersistedDeliverableRef[] = hashes.flatMap((sha256) => {
		const row = bySha.get(sha256);
		return row ? [{ name: row.name, size: row.size, sha256 }] : [];
	});
	if (files.length === 0) error(400, "None of those files are stored for this conversation");

	const update: MessageCodeExecutionOutputsUpdate = {
		type: MessageUpdateType.CodeExecution,
		subtype: MessageCodeExecutionUpdateType.Outputs,
		runKey,
		files,
	};

	// Idempotent: the same run's same files recorded twice (a remount, a retry
	// after a dropped response) leave one record — the unique index answers the
	// race too. A re-run that produced different bytes is a new record, and so
	// a new version of the file artifact.
	const fingerprint = files.map((f) => f.sha256).join(",");

	// A runaway loop that keeps producing "new" run-file records would
	// otherwise grow this collection without limit. Re-recording an existing
	// record (the idempotent case above) never counts against the cap; only a
	// genuinely new record does.
	const existing = await collections.codeRunFiles.findOne({
		conversationId,
		messageId,
		runKey,
		fingerprint,
	});
	if (!existing) {
		const count = await collections.codeRunFiles.countDocuments({ conversationId });
		if (count >= MAX_CODE_RUN_FILES_PER_CONVERSATION) {
			error(429, "This conversation has reached its limit of recorded run outputs.");
		}
	}

	await collections.codeRunFiles
		.updateOne(
			{ conversationId, messageId, runKey, fingerprint },
			{
				$setOnInsert: {
					conversationId,
					messageId,
					runKey,
					fingerprint,
					files,
					createdAt: new Date(),
				},
			},
			{ upsert: true }
		)
		.catch((err: { code?: number }) => {
			// Two concurrent upserts of the same record: the other one won.
			if (err?.code !== 11000) throw err;
		});

	return json({ update });
};
