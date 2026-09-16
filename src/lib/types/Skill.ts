import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * A user skill: a SKILL.md document somebody wrote for themselves (Phase 1,
 * ADR 0072).
 *
 * The *format* is the open SKILL.md shape verbatim — YAML frontmatter with
 * required `name` + `description`, markdown body, optional `scripts/`,
 * `references/` and `assets/` directories — so a skill ports in and out
 * unchanged. The *storage* is one Mongo document per skill holding the raw
 * file text, with `name`/`description` denormalized beside it for the
 * every-turn frontmatter listing. There is no sharing and no versioning:
 * owner-only, live-read, like a file in git.
 *
 * A skill is instructions, never code that runs here. Nothing server-side
 * executes it: the model reads the body and carries it out through the same
 * client-side sandbox (`execute_code` / fences) it already uses. A skill
 * whose workflow needs bash is out of scope by architecture — this box is
 * multi-tenant with no server isolation — not by omission.
 */
export interface Skill extends Timestamps {
	_id: ObjectId;
	/** Whose skill this is. Owner-only: no sharing, no publish flow (Phase 1). */
	userId: User["_id"];
	/**
	 * Whose skill this is.
	 *
	 * `user` — one person's, visible and editable only by them. The original
	 * shape, and still the default: a document with no `scope` is one added
	 * before this existed and is treated as `user`.
	 *
	 * `deployment` — an administrator's, readable by everybody and writable
	 * only by an administrator (enforced server-side on every admin op, never
	 * trusted from the client). The definition is shared, and the sharing is
	 * trivially safe because a skill holds no secrets — it is instructions,
	 * not credentials. `userId` then records only which administrator added
	 * it, kept because "who put this here" is asked about something every
	 * account reads.
	 */
	scope?: "user" | "deployment";
	/** From frontmatter. Unique per owner. */
	name: string;
	/** From frontmatter. What the model matches against. */
	description: string;
	/** The full SKILL.md text, frontmatter included. */
	content: string;
	/** Per-skill on/off. On at creation. */
	enabled: boolean;
}

/** What the browser is given for one user skill. The body arrives on demand. */
export interface SkillView {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	updatedAt: string;
}

/** What the browser is given for one admin seed: read-only, always on. */
export interface AdminSkillView {
	name: string;
	description: string;
	readOnly: true;
}
