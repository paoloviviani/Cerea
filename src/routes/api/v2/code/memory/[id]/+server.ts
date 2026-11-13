/**
 * One agent note: rewrite it, or delete it. The note id is matched together with the owner,
 * computer, scope and key, so an id from another session, workspace, computer or user is a 404.
 * `PATCH { deviceId, scope, key, text }`, `DELETE ?device=&scope=&key=`.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { getOwnedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	agentNoteViews,
	deleteAgentNote,
	MemoryValidationError,
	updateAgentNote,
} from "$lib/server/memory/service";
import { AGENT_MEMORY_TEXT_MAX_CHARS } from "$lib/types/ScopedMemory";

const scope = z.enum(["session", "workspace"]);
const keySchema = z.string().min(1).max(256);

function noteId(params: { id?: string }): ObjectId {
	if (!params.id || !ObjectId.isValid(params.id)) error(404, "No such note.");
	return new ObjectId(params.id);
}

const patchSchema = z.object({
	deviceId: z.string().min(1).max(64),
	scope,
	key: keySchema,
	text: z.string().trim().min(1).max(AGENT_MEMORY_TEXT_MAX_CHARS),
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	await requireCodeAgents(locals);
	if (!memoryEnabled()) error(404, "Notes are not turned on here.");
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	const device = await getOwnedDevice(locals, parsed.data.deviceId);
	const key = {
		userId: device.userId,
		deviceId: device._id.toString(),
		scope: parsed.data.scope,
		key: parsed.data.key,
	};
	try {
		const updated = await updateAgentNote(key, noteId(params), parsed.data.text);
		const view = (await agentNoteViews(key)).find((note) => note.id === updated._id.toString());
		return json({ data: view });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			error(err.message === "No such note." ? 404 : 400, err.message);
		}
		throw err;
	}
};

/** Allowed with the flag off too: an operator switching notes off must not strand what is stored. */
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	await requireCodeAgents(locals);
	const parsed = z
		.object({ scope, key: keySchema })
		.safeParse({ scope: url.searchParams.get("scope"), key: url.searchParams.get("key") });
	if (!parsed.success) error(400, "Expected ?device=, ?scope=session|workspace and ?key=.");
	const device = await getOwnedDevice(locals, url.searchParams.get("device"));
	const deleted = await deleteAgentNote(
		{ userId: device.userId, deviceId: device._id.toString(), ...parsed.data },
		noteId(params)
	);
	if (!deleted) error(404, "No such note.");
	return new Response(null, { status: 204 });
};
