/**
 * User skills: storage, validation, and the turn-time loading surface
 * (Phase 1, ADR 0072; deployment-scope management, ADR 0072 amendment).
 *
 * **Storage: Mongo, following the knowledge-base pattern of ADR 0070.**
 * Skills are per-user owned data with enable/disable state and CRUD through
 * an API — the same shape as `McpConnector` (definition beside its owner in
 * Mongo), not files: decision 5 rejected versioning, so there is no git-like
 * history to keep, and a live-read of one document per skill is exactly
 * "files = git" without a filesystem to synchronize.
 *
 * **Scope flag, not a second system.** Admin skills live in this same
 * `skills` collection with `scope: "deployment"` (readable by all users,
 * writable only by an administrator — enforced server-side on every admin
 * op, never trusted from the client), shaped like a `deployment`-scoped
 * connector whose sharing is trivially safe because a skill holds no
 * secrets. A document with no `scope` is one added before this existed and
 * is treated as `user`, the safe direction (the alternative would silently
 * publish somebody's personal skill to the whole deployment). User skills
 * keep owner scope exactly as before: every owner-scoped query carries
 * `scope: { $ne: "deployment" }`, which also matches documents with no
 * scope field at all.
 *
 * **Seeds become bootstrap.** The three code definitions in `adminSkills.ts`
 * stay the fallback source of truth, but on first read they are inserted as
 * deployment-scope rows when absent (seed-once, idempotent, never
 * overwriting an edited row, never duplicating); the panel manages DB rows
 * thereafter. Turn-time resolution reads the DB rows first and falls back to
 * code when the store cannot be read — retrieval never fails a turn — and
 * `CHAT_SKILLS_DISABLED` filters by name regardless of source.
 *
 * **No execution here.** This module never touches the sandbox, the
 * `execute_code` tool, or any exec API: a skill body is text handed to the
 * model, and Python runs only where the model puts it — client-side,
 * through the existing sandbox tools. Portable skills with shell scripts
 * do NOT transfer here: Cerea skills are instructions +
 * stdlib-Python-or-nothing, out of scope by architecture (multi-tenant
 * box, no server isolation), not by omission.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { AdminSkillView, Skill, SkillView } from "$lib/types/Skill";
import { ADMIN_SKILL_CONTENTS, adminDisabledSkillNames } from "./adminSkills";
import { isParsedSkill, parseSkill, type ParsedSkill } from "./parse";
import type { BuiltinTool } from "$lib/server/textGeneration/builtinTools/types";

export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** Thrown when a SKILL.md document fails validation. Carries the logged reason. */
export class SkillValidationError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SkillValidationError";
	}
}

export function skillView(skill: Skill): SkillView {
	return {
		id: skill._id.toString(),
		name: skill.name,
		description: skill.description,
		enabled: skill.enabled,
		updatedAt: skill.updatedAt.toISOString(),
	};
}

interface AdminSkill {
	name: string;
	description: string;
	body: string;
}

let cachedAdminSkills: AdminSkill[] | undefined;

/**
 * The seeded definitions, parsed and validated once. A seed that fails to
 * parse is dropped with a logged reason — a broken seed must never fail a
 * turn — which is also what the seed spec pins.
 */
export function listAdminSkills(): AdminSkill[] {
	if (!cachedAdminSkills) {
		const parsed: AdminSkill[] = [];
		for (const content of ADMIN_SKILL_CONTENTS) {
			const result = parseSkill(content);
			if (!isParsedSkill(result)) continue;
			parsed.push({ name: result.name, description: result.description, body: result.body });
		}
		cachedAdminSkills = parsed;
	}
	const disabled = adminDisabledSkillNames();
	return cachedAdminSkills.filter((skill) => !disabled.has(skill.name));
}

/** Test hook: forget the parsed seeds so env changes take effect. */
export function resetAdminSkillCache(): void {
	cachedAdminSkills = undefined;
}

export function adminSkillViews(): AdminSkillView[] {
	return listAdminSkills().map((skill) => ({
		name: skill.name,
		description: skill.description,
		readOnly: true as const,
	}));
}

/**
 * Scope predicate for owner-scoped queries. Matches `user` rows and rows
 * written before `scope` existed alike: in Mongo, `$ne` also matches
 * documents where the field is missing, so no migration is needed.
 */
const USER_SCOPE = { scope: { $ne: "deployment" as const } };

let seedsEnsured = false;

/** Test hook: run the seed-once bootstrap again next call. */
export function resetSeedEnsured(): void {
	seedsEnsured = false;
}

/**
 * Seed-once bootstrap: insert the three code definitions as
 * deployment-scope rows when absent. Idempotent — an existing row (possibly
 * edited by an administrator) is never overwritten, and the unique
 * `{scope, name}` index makes a raced double-insert a caught duplicate
 * rather than a duplicate row. Runs once per process; turn-time callers
 * that arrive before any listing still resolve through the code fallback
 * below, so a fresh deployment answers turns correctly from boot.
 */
export async function ensureDeploymentSeeds(): Promise<void> {
	if (seedsEnsured) return;
	seedsEnsured = true;
	for (const content of ADMIN_SKILL_CONTENTS) {
		const parsed = parseSkill(content);
		if (!isParsedSkill(parsed)) continue;
		const existing = await collections.skills.findOne(
			{ scope: "deployment", name: parsed.name },
			{ projection: { _id: 1 } }
		);
		if (existing) continue;
		const now = new Date();
		try {
			await collections.skills.insertOne({
				_id: new ObjectId(),
				userId: new ObjectId(),
				scope: "deployment" as const,
				name: parsed.name,
				description: parsed.description,
				content,
				enabled: true,
				createdAt: now,
				updatedAt: now,
			});
		} catch (err) {
			// A raced bootstrap inserting the same name: the row exists now,
			// which is the outcome wanted. Anything else is real.
			if (err instanceof Error && /duplicate key/i.test(err.message)) {
				continue;
			}
			throw err;
		}
	}
}

/**
 * Every deployment-scope row, bootstrapped first so the three seeds appear
 * manageable rather than duplicated beside their code definitions — the
 * panel manages DB rows thereafter, and code seeds stay the fallback source
 * of truth, not a parallel catalogue. Kill-switched names are filtered by
 * name regardless of source, exactly like the code seeds.
 */
export async function listDeploymentSkills(): Promise<Skill[]> {
	await ensureDeploymentSeeds();
	const disabled = adminDisabledSkillNames();
	return collections.skills
		.find({ scope: "deployment" })
		.sort({ name: 1 })
		.toArray()
		.then((rows) => rows.filter((row) => !disabled.has(row.name)));
}

/** Enabled deployment rows for turn-time callers (kill-switch filtered). */
export async function listEnabledDeploymentSkills(): Promise<Skill[]> {
	try {
		await ensureDeploymentSeeds();
		const disabled = adminDisabledSkillNames();
		const rows = await collections.skills
			.find({ scope: "deployment", enabled: true })
			.sort({ name: 1 })
			.toArray();
		return rows.filter((row) => !disabled.has(row.name));
	} catch (err) {
		logger.warn({ err: String(err) }, "[skills] deployment skill lookup failed");
		return [];
	}
}

/** One deployment row's body for the admin detail view (any signed-in user may read). */
export async function getDeploymentSkill(id: ObjectId): Promise<Skill | null> {
	await ensureDeploymentSeeds();
	return collections.skills.findOne({ _id: id, scope: "deployment" });
}

/**
 * Store one deployment-scope SKILL.md document. Same validation rules as
 * user skills — invalid frontmatter is rejected with the logged reason,
 * never stored. A name collision with an existing deployment row is an
 * error naming the clash. The server's admin gate owns the permission;
 * this function owns the scope.
 */
export async function createDeploymentSkill(actorId: ObjectId, content: string): Promise<Skill> {
	await ensureDeploymentSeeds();
	const parsed = parseSkill(content);
	if (!isParsedSkill(parsed)) invalid(parsed.reason);
	const existing = await collections.skills.findOne(
		{ scope: "deployment", name: parsed.name },
		{ projection: { _id: 1 } }
	);
	if (existing) invalid(`there is already a built-in skill named \`${parsed.name}\``);
	const now = new Date();
	const skill: Skill = {
		_id: new ObjectId(),
		userId: actorId,
		scope: "deployment",
		name: parsed.name,
		description: parsed.description,
		content,
		enabled: true,
		createdAt: now,
		updatedAt: now,
	};
	try {
		await collections.skills.insertOne(skill);
	} catch (err) {
		if (err instanceof Error && /duplicate key/i.test(err.message)) {
			invalid(`there is already a built-in skill named \`${parsed.name}\``);
		}
		throw err;
	}
	return skill;
}

/**
 * Edit a deployment row's body and/or enabled flag — disabling is a toggle,
 * not a delete. Replacement bodies are validated like a create; a rename
 * that collides with another deployment row is rejected like a create.
 */
export async function updateDeploymentSkill(id: ObjectId, update: SkillUpdate): Promise<Skill> {
	const skill = await collections.skills.findOne({ _id: id, scope: "deployment" });
	if (!skill) invalid("skill not found");
	const set: Partial<Skill> = { updatedAt: new Date() };
	if (typeof update.enabled === "boolean") set.enabled = update.enabled;
	if (update.content !== undefined) {
		const parsed = parseSkill(update.content);
		if (!isParsedSkill(parsed)) invalid(parsed.reason);
		if (parsed.name !== skill.name) {
			const clash = await collections.skills.findOne(
				{ scope: "deployment", name: parsed.name },
				{ projection: { _id: 1 } }
			);
			if (clash) invalid(`there is already a built-in skill named \`${parsed.name}\``);
			set.name = parsed.name;
		}
		set.description = parsed.description;
		set.content = update.content;
	}
	await collections.skills.updateOne({ _id: id, scope: "deployment" }, { $set: set });
	const updated = await collections.skills.findOne({ _id: id, scope: "deployment" });
	if (!updated) invalid("skill not found");
	return updated;
}

export async function deleteDeploymentSkill(id: ObjectId): Promise<boolean> {
	const result = await collections.skills.deleteOne({ _id: id, scope: "deployment" });
	return result.deletedCount === 1;
}

/** Every enabled skill this turn may see: the owner's, plus the admin seeds. */
export async function listEnabledUserSkills(userId: ObjectId): Promise<Skill[]> {
	return collections.skills
		.find({ userId, enabled: true, ...USER_SCOPE })
		.sort({ name: 1 })
		.toArray();
}

/** All of one owner's skills, on or off, for the manager screen. */
export async function listUserSkills(userId: ObjectId): Promise<Skill[]> {
	return collections.skills
		.find({ userId, ...USER_SCOPE })
		.sort({ name: 1 })
		.toArray();
}

/** Whether the turn has anything to advertise: any seed, or one enabled skill. */
export async function skillsAvailable(userId?: ObjectId): Promise<boolean> {
	if (listAdminSkills().length > 0) return true;
	try {
		await ensureDeploymentSeeds();
		const disabled = adminDisabledSkillNames();
		const count = await collections.skills.countDocuments(
			{
				$or: [
					{ scope: "deployment", enabled: true, name: { $nin: [...disabled] } },
					...(userId ? [{ userId, enabled: true, ...USER_SCOPE }] : []),
				],
			},
			{ limit: 1 }
		);
		return count > 0;
	} catch {
		if (!userId) return false;
		try {
			const count = await collections.skills.countDocuments(
				{ userId, enabled: true, ...USER_SCOPE },
				{ limit: 1 }
			);
			return count > 0;
		} catch (err) {
			logger.warn({ err: String(err) }, "[skills] availability check failed");
			return false;
		}
	}
}

function toSkill(userId: ObjectId, parsed: ParsedSkill, content: string): Skill {
	const now = new Date();
	return {
		_id: new ObjectId(),
		userId,
		name: parsed.name,
		description: parsed.description,
		content,
		enabled: true,
		createdAt: now,
		updatedAt: now,
	};
}

function invalid(reason: string): never {
	throw new SkillValidationError(reason);
}

/**
 * Store one SKILL.md document. Invalid frontmatter is rejected with the
 * logged reason — never stored, never listed. A name collision with the
 * owner's existing skill replaces nothing: it is an error naming the clash.
 */
export async function createSkill(userId: ObjectId, content: string): Promise<Skill> {
	const parsed = parseSkill(content);
	if (!isParsedSkill(parsed)) invalid(parsed.reason);
	const existing = await collections.skills.findOne(
		{ userId, name: parsed.name, ...USER_SCOPE },
		{ projection: { _id: 1 } }
	);
	if (existing) invalid(`you already have a skill named \`${parsed.name}\``);
	const skill = toSkill(userId, parsed, content);
	await collections.skills.insertOne(skill);
	return skill;
}

export interface SkillUpdate {
	/** Replacement SKILL.md text; re-validated, and may rename the skill. */
	content?: string;
	enabled?: boolean;
}

/**
 * Edit the body and/or the enabled flag. A replacement body is validated
 * like a create; a rename that collides is rejected like a create.
 */
export async function updateSkill(
	userId: ObjectId,
	id: ObjectId,
	update: SkillUpdate
): Promise<Skill> {
	const skill = await collections.skills.findOne({ _id: id, userId, ...USER_SCOPE });
	if (!skill) invalid("skill not found");
	const set: Partial<Skill> = { updatedAt: new Date() };
	if (typeof update.enabled === "boolean") set.enabled = update.enabled;
	if (update.content !== undefined) {
		const parsed = parseSkill(update.content);
		if (!isParsedSkill(parsed)) invalid(parsed.reason);
		if (parsed.name !== skill.name) {
			const clash = await collections.skills.findOne(
				{ userId, name: parsed.name, ...USER_SCOPE },
				{ projection: { _id: 1 } }
			);
			if (clash) invalid(`you already have a skill named \`${parsed.name}\``);
			set.name = parsed.name;
		}
		set.description = parsed.description;
		set.content = update.content;
	}
	await collections.skills.updateOne({ _id: id, userId, ...USER_SCOPE }, { $set: set });
	const updated = await collections.skills.findOne({ _id: id, userId, ...USER_SCOPE });
	if (!updated) invalid("skill not found");
	return updated;
}

export async function deleteSkill(userId: ObjectId, id: ObjectId): Promise<boolean> {
	const result = await collections.skills.deleteOne({ _id: id, userId, ...USER_SCOPE });
	return result.deletedCount === 1;
}

export interface ResolvedSkillBody {
	/** Whose definition this came from. A user's own skill wins over a seed. */
	owner: "user" | "admin";
	name: string;
	description: string;
	body: string;
}

/**
 * One skill's body, by name: the owner's enabled skill first, then the
 * deployment rows, then the code seeds. Unknown, disabled, or kill-switched
 * names resolve to undefined — silently, never an error to the user.
 */
export async function findSkillBody(
	userId: ObjectId | undefined,
	name: string
): Promise<ResolvedSkillBody | undefined> {
	if (userId) {
		try {
			const skill = await collections.skills.findOne({
				userId,
				name,
				enabled: true,
				...USER_SCOPE,
			});
			if (skill) {
				return {
					owner: "user",
					name: skill.name,
					description: skill.description,
					body: skillBody(skill.content) ?? skill.content,
				};
			}
		} catch (err) {
			logger.warn({ err: String(err), name }, "[skills] user skill lookup failed");
		}
	}
	try {
		await ensureDeploymentSeeds();
		const row = await collections.skills.findOne({
			scope: "deployment",
			name,
			enabled: true,
		});
		if (row && !adminDisabledSkillNames().has(row.name)) {
			return {
				owner: "admin",
				name: row.name,
				description: row.description,
				body: skillBody(row.content) ?? row.content,
			};
		}
		if (row) return undefined;
	} catch (err) {
		logger.warn({ err: String(err), name }, "[skills] deployment skill lookup failed");
	}
	const admin = listAdminSkills().find((seed) => seed.name === name);
	if (admin) {
		return { owner: "admin", name: admin.name, description: admin.description, body: admin.body };
	}
	return undefined;
}

/** The markdown body of a stored document (frontmatter stripped). */
function skillBody(content: string): string | undefined {
	const parsed = parseSkill(content);
	return isParsedSkill(parsed) ? parsed.body : undefined;
}

/**
 * Offer `load_skill` to this turn when there is anything to load: any seed,
 * or one enabled skill of the turn's owner. Pushes onto the turn's builtin
 * list in place and reports whether it did. Never throws — a store that
 * cannot be read contributes no tool, not no answer.
 */
export async function includeSkillLoadBuiltin(
	tools: BuiltinTool[],
	userId?: ObjectId
): Promise<boolean> {
	try {
		if (!(await skillsAvailable(userId))) return false;
		tools.push(skillLoadBuiltin);
		return true;
	} catch (err) {
		logger.warn({ err: String(err) }, "[skills] load_skill unavailable; continuing without it");
		return false;
	}
}

/**
 * The stage-2 tool: `load_skill`. This is the model's own half of
 * progressive disclosure — the frontmatter list rides every turn, and the
 * model loads a body mid-turn through the normal tool flow when a
 * description matches the work at hand.
 *
 * The result is plain text the model reads next round. It invokes nothing,
 * executes nothing, and never touches an exec API: skill content reaches
 * the model only as prompt text, and Python runs only where the model puts
 * it — client-side, through the existing sandbox tools.
 */
export const skillLoadBuiltin: BuiltinTool = {
	name: LOAD_SKILL_TOOL_NAME,
	definition: {
		type: "function",
		function: {
			name: LOAD_SKILL_TOOL_NAME,
			description:
				"Load one skill's full instructions into context. The system prompt lists " +
				"the available skills with one-line descriptions; when one matches the work " +
				"at hand, call this with its exact `name` and follow the returned procedure " +
				"using the app's normal capabilities (notably the Python sandbox, which takes " +
				"standard-library code only). A skill is instructions for you to carry out — " +
				"it runs nothing by itself.",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "The skill's exact name, as listed in the system prompt.",
					},
				},
				required: ["name"],
			},
		},
	},
	async execute(args, ctx) {
		const name = typeof args.name === "string" ? args.name.trim() : "";
		if (!name) return { error: "Pass the skill's exact `name` as listed in the system prompt." };
		const resolved = await findSkillBody(ctx.userId, name);
		if (!resolved) {
			return {
				error: `There is no enabled skill named \`${name}\`. Use only the names listed in the system prompt.`,
			};
		}
		return {
			resultText: `# Skill: ${resolved.name}\n\n${resolved.description}\n\n${resolved.body}`,
		};
	},
};
