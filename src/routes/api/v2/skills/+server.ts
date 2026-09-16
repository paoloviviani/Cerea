/**
 * Skills (Phase 1, ADR 0072; deployment-scope management, ADR 0072 amendment):
 * what this person has, what the deployment offers, and adding one.
 *
 * Owner-only beside deployment-shared, like `user`- versus `deployment`-scoped
 * connectors: the listing carries the deployment rows (readable by everybody,
 * bootstrapped from the code seeds on first read so they appear manageable
 * rather than duplicated) beside the caller's own skills. Creating one stores
 * a SKILL.md document verbatim; invalid frontmatter is rejected with the
 * logged reason, never stored. Creating with `scope: "deployment"` is an
 * administrator's act and calls `requireAdmin` — the gateway's answer, never
 * a client flag — before anything is stored.
 *
 * A multipart `POST` (a zip of a skill folder, Stage 3) is the import path
 * for a multi-file skill — `SKILL.md` plus `scripts/`, `references/` and
 * `assets/` — and takes the same `scope` rule and the same admin gate,
 * before the archive is even opened.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import {
	createDeploymentSkill,
	createDeploymentSkillFromZip,
	createSkill,
	createSkillFromZip,
	listDeploymentSkills,
	listUserSkills,
	skillView,
	SkillValidationError,
} from "$lib/server/skills/service";

const create = z.object({
	/** The full SKILL.md text, frontmatter included. Validated, not trusted. */
	content: z.string().trim().min(1).max(100_000),
	/**
	 * `deployment` publishes to everybody and requires an administrator.
	 * Defaults to `user`: a skill somebody adds for themselves must never
	 * become the whole deployment's by omission.
	 */
	scope: z.enum(["user", "deployment"]).default("user"),
});

/**
 * Upload cap for the zip itself, ahead of `parseSkillZip`'s own per-file and
 * total-content caps: a compressed archive under this size cannot possibly
 * unpack to more than a small multiple of it before those caps reject it,
 * so this just keeps an oversized upload from being read into memory at all.
 */
const SKILL_ZIP_MAX_BYTES = 20_000_000;

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const skills = await listUserSkills(user._id);
	const deployment = await listDeploymentSkills();
	return json({
		data: { user: skills.map(skillView), admin: deployment.map(skillView) },
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const form = await request.formData();
		const scope = form.get("scope") === "deployment" ? "deployment" : "user";
		const file = form.get("file");
		if (!(file instanceof File)) error(400, "Attach the skill's zip as `file`.");
		if (file.size > SKILL_ZIP_MAX_BYTES) {
			error(400, `The zip is too large (max ${SKILL_ZIP_MAX_BYTES} bytes).`);
		}
		const zip = new Uint8Array(await file.arrayBuffer());
		try {
			if (scope === "deployment") {
				await requireAdmin(locals);
				const skill = await createDeploymentSkillFromZip(user._id, zip);
				return json({ data: skillView(skill) }, { status: 201 });
			}
			const skill = await createSkillFromZip(user._id, zip);
			return json({ data: skillView(skill) }, { status: 201 });
		} catch (err) {
			if (err instanceof SkillValidationError) error(400, err.message);
			throw err;
		}
	}
	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That skill is not valid.");
	}
	try {
		if (parsed.data.scope === "deployment") {
			// Checked before parsing the skill, so a non-administrator does
			// not get a validation answer to a request that is a 403.
			await requireAdmin(locals);
			const skill = await createDeploymentSkill(user._id, parsed.data.content);
			return json({ data: skillView(skill) }, { status: 201 });
		}
		const skill = await createSkill(user._id, parsed.data.content);
		return json({ data: skillView(skill) }, { status: 201 });
	} catch (err) {
		if (err instanceof SkillValidationError) error(400, err.message);
		throw err;
	}
};
