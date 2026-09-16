import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * One bundled file under a skill's `scripts/`, `references/` or `assets/`
 * directory (Stage 3, ADR 0072). Stored beside the skill document rather
 * than on a filesystem, like `content` — a live-read Mongo field, not a
 * versioned artifact.
 *
 * Text is stored as-is; anything that does not round-trip through UTF-8 (a
 * template `.docx`, an image) is stored `base64`-encoded instead. Either way
 * this is inert data the server never executes — `load_skill_file` hands it
 * to the model as text, and the model is the one that decides what to do
 * with it, client-side, through the sandbox.
 */
export interface SkillFile {
	/** Relative path within the skill folder, always under `scripts/`, `references/` or `assets/`. */
	path: string;
	/** The file's content: UTF-8 text, or base64 when `encoding` says so. */
	content: string;
	/** Present only when `content` is base64 — a file that isn't valid UTF-8 text. */
	encoding?: "base64";
}

/**
 * A user skill: a SKILL.md document somebody wrote for themselves (Phase 1,
 * ADR 0072), optionally with bundled files (Stage 3).
 *
 * The *format* is the open SKILL.md shape verbatim — YAML frontmatter with
 * required `name` + `description`, markdown body, optional `scripts/`,
 * `references/` and `assets/` directories — so a skill ports in and out
 * unchanged. The *storage* is one Mongo document per skill holding the raw
 * file text (plus any bundled files, imported from a zip of the skill
 * folder), with `name`/`description` denormalized beside it for the
 * every-turn frontmatter listing. There is no sharing and no versioning:
 * owner-only, live-read, like a file in git.
 *
 * A skill is instructions, never code that runs here. Nothing server-side
 * executes it: the model reads the body (and, on request, a bundled file's
 * text through `load_skill_file`) and carries it out through the same
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
	/** Bundled `scripts/`/`references/`/`assets/` files, imported from a zip. Empty for a SKILL.md-only skill. */
	files?: SkillFile[];
}

/** What the browser is given for one user skill. The body arrives on demand. */
export interface SkillView {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	updatedAt: string;
	/** Bundled file paths only — content is fetched per file, on demand. */
	files: string[];
}

/** What the browser is given for one admin seed: read-only, always on. */
export interface AdminSkillView {
	name: string;
	description: string;
	readOnly: true;
}
