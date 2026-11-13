/**
 * An agent's notes, for the code panel: the notes of one session or one workspace on one of
 * the caller's computers. `GET ?device=&scope=&key=` lists them, `POST { deviceId, scope, key,
 * text }` adds one the owner typed.
 *
 * Owner only: the device must be the caller's own (`getOwnedDevice`), and every read and write
 * is keyed by owner + computer + scope + key, so another user's or another computer's notes are
 * not reachable by guessing a key. Only `session` and `workspace` exist here; the chat's own
 * memory has its own routes and is never reachable through this one.
 *
 * The notes were written by an agent that may have read hostile code, so the panel shows them as
 * notes, and the chat never reads them.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { getOwnedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	agentNoteViews,
	MemoryValidationError,
	rememberAgentNote,
} from "$lib/server/memory/service";
import { AGENT_MEMORY_TEXT_MAX_CHARS } from "$lib/types/ScopedMemory";

const scope = z.enum(["session", "workspace"]);
const keySchema = z.string().min(1).max(256);

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireCodeAgents(locals);
	if (!memoryEnabled()) error(404, "Notes are not turned on here.");
	const parsed = z
		.object({ scope, key: keySchema })
		.safeParse({ scope: url.searchParams.get("scope"), key: url.searchParams.get("key") });
	if (!parsed.success) error(400, "Expected ?device=, ?scope=session|workspace and ?key=.");
	const device = await getOwnedDevice(locals, url.searchParams.get("device"));
	const notes = await agentNoteViews({
		userId: device.userId,
		deviceId: device._id.toString(),
		...parsed.data,
	});
	return json({ data: { notes } });
};

const createSchema = z.object({
	deviceId: z.string().min(1).max(64),
	scope,
	key: keySchema,
	text: z.string().trim().min(1).max(AGENT_MEMORY_TEXT_MAX_CHARS),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	await requireCodeAgents(locals);
	if (!memoryEnabled()) error(404, "Notes are not turned on here.");
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, parsed.error.issues[0]?.message ?? "That note is not valid.");
	const device = await getOwnedDevice(locals, parsed.data.deviceId);
	const key = {
		userId: device.userId,
		deviceId: device._id.toString(),
		scope: parsed.data.scope,
		key: parsed.data.key,
	};
	try {
		// `source: "user"`: this route is the panel; an agent writes through the machine call.
		const { memory } = await rememberAgentNote(key, { text: parsed.data.text, source: "user" });
		const view = (await agentNoteViews(key)).find((note) => note.id === memory._id.toString());
		return json({ data: view }, { status: 201 });
	} catch (err) {
		if (err instanceof MemoryValidationError) error(400, err.message);
		throw err;
	}
};
