/**
 * Agent auto-approval, server side (ADR 0107, reshaped by ADR 0109): each user's own settings, the
 * administrator's one switch, the review log and the deployment kill switch. The review service
 * (routing, the model call) builds on these.
 *
 * `CHAT_AUTO_PERMISSIONS` is the **kill switch**, shaped like `CHAT_SCHEDULES_ENABLED`: on unless
 * exactly "false". On by default because it grants nothing by itself: the reviewer runs only when the
 * administrator's switch is on and the user turned theirs on with a decision model.
 * Off: no reviewer runs and Auto's cards come to the user.
 */
import { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import {
	INSTRUCTIONS_MAX,
	MAX_PER_HOUR_DEFAULT,
	MAX_PER_HOUR_MAX,
	PER_CLASS_DEFAULTS,
	SUMMARY_MAX,
	THRESHOLD_DEFAULT,
	THRESHOLD_MAX,
	THRESHOLD_MIN,
	type AgentReviewLogEntry,
	type AgentReviewSettings,
	type ReviewAnswerer,
	type ReviewOutcome,
} from "$lib/types/AgentReview";
import type { AutoClasses } from "$lib/types/machineProtocol";
import { reviewerDegraded } from "$lib/server/review/health";
import { PERMISSION_CLASSES, type PermissionClass } from "$lib/types/machineProtocol";

export const REVIEW_LOG_TTL_SECONDS = 90 * 24 * 60 * 60;

export function autoPermissionsEnabled(): boolean {
	return config.CHAT_AUTO_PERMISSIONS !== "false";
}

/** The fixed frame's markers: refused inside the editable text so it cannot close or reopen the frame. */
export const FENCE_MARKERS = ["<<<", ">>>", "```", "</", "[[", "]]", "BEGIN ", "END "];

export class SettingsInvalid extends Error {}

export function defaultSettings(): AgentReviewSettings {
	return {
		enabled: false,
		decisionModelId: null,
		threshold: THRESHOLD_DEFAULT,
		instructions: "",
		perClass: { ...PER_CLASS_DEFAULTS },
		maxPerHourPerMachine: MAX_PER_HOUR_DEFAULT,
	};
}

/** Fills gaps and fixes what must not vary (`loop` is always "you", `secrets` never "run"); never
 * throws on stored data. */
export function normalize(
	raw:
		| (Omit<Partial<AgentReviewSettings>, "perClass"> & {
				perClass?: Partial<AgentReviewSettings["perClass"]>;
		  })
		| null
		| undefined
): AgentReviewSettings {
	const d = defaultSettings();
	if (!raw) return d;
	const perClass = { ...d.perClass };
	for (const c of PERMISSION_CLASSES) {
		const v = raw.perClass?.[c];
		if (v === "you" || v === "reviewer" || v === "run") perClass[c] = v;
	}
	perClass.loop = "you";
	if (perClass.secrets === "run") perClass.secrets = "you";
	const t =
		typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
			? raw.threshold
			: d.threshold;
	const cap =
		typeof raw.maxPerHourPerMachine === "number" && raw.maxPerHourPerMachine >= 1
			? Math.min(Math.floor(raw.maxPerHourPerMachine), MAX_PER_HOUR_MAX)
			: d.maxPerHourPerMachine;
	return {
		enabled: raw.enabled === true,
		decisionModelId:
			typeof raw.decisionModelId === "string" && raw.decisionModelId.trim()
				? raw.decisionModelId.trim()
				: null,
		threshold: Math.min(Math.max(t, THRESHOLD_MIN), THRESHOLD_MAX),
		instructions: typeof raw.instructions === "string" ? raw.instructions : "",
		perClass,
		maxPerHourPerMachine: cap,
		updatedAt: raw.updatedAt,
	};
}

// -- the deployment: one switch, and the earlier settings kept as the seed ----------------------

/** The earlier deployment-level document (read only to seed users; its `enabled` is the switch). */
async function getDeploymentDoc(): Promise<AgentReviewSettings> {
	return normalize(await collections.agentReviewConfig.findOne({}));
}

/** The administrator's switch: Auto may use a reviewer on this deployment. */
export async function getDeploymentReviewEnabled(): Promise<boolean> {
	return (await getDeploymentDoc()).enabled;
}

/** Sets only the switch; the earlier settings in the document stay (they seed users). */
export async function setDeploymentReviewEnabled(enabled: boolean): Promise<void> {
	await collections.agentReviewConfig.updateOne(
		{},
		{ $set: { enabled, updatedAt: new Date() } },
		{ upsert: true }
	);
}

// -- the user's own settings ----------------------------------------------------------------

/** What a user with no document of their own starts from: the deployment's earlier model,
 * threshold, instructions and rows; the reviewer is on only when there was a model to copy. */
function seedFromDeployment(dep: AgentReviewSettings): AgentReviewSettings {
	// Under machine limits the default machine let edits, web, agents and tools run, so a stored
	// "reviewer" row for them never saw a card: it seeds as "run", which is what actually happened.
	const perClass = { ...dep.perClass };
	for (const c of ["edit", "web", "agents", "tools"] as const) {
		if (perClass[c] === "reviewer") perClass[c] = "run";
	}
	return normalize({ ...dep, perClass, enabled: dep.decisionModelId !== null });
}

/**
 * One user's settings. First read with none: the deployment's earlier settings are copied in as
 * the user's own (copy-on-read, never a bulk migration); with nothing to copy the defaults are
 * returned and nothing is stored until the user saves.
 */
export async function getUserReviewSettings(userId: ObjectId): Promise<AgentReviewSettings> {
	const row = await collections.agentReviewUserSettings.findOne({ userId });
	if (row) return normalize(row);
	const dep = await getDeploymentDoc();
	const seed = seedFromDeployment(dep);
	if (dep.decisionModelId === null) return seed;
	try {
		await collections.agentReviewUserSettings.updateOne(
			{ userId },
			{ $setOnInsert: { ...seed, userId, updatedAt: new Date() } },
			{ upsert: true }
		);
	} catch (err) {
		// A concurrent first read inserted it: theirs is the same copy.
		if ((err as { code?: number }).code !== 11000) throw err;
	}
	return seed;
}

/**
 * Validates and stores one user's settings. Throws `SettingsInvalid` with a sentence for the user.
 * Refuses (rather than clamps) a threshold below the floor, an over-long text and fence markers.
 * The standard-case test never gates this.
 */
export async function saveUserReviewSettings(
	userId: ObjectId,
	input: Partial<Omit<AgentReviewSettings, "perClass">> & {
		perClass?: Partial<AgentReviewSettings["perClass"]>;
	}
): Promise<AgentReviewSettings> {
	const next = normalize({ ...input, perClass: { ...PER_CLASS_DEFAULTS, ...input.perClass } });
	if (
		typeof input.threshold === "number" &&
		(input.threshold < THRESHOLD_MIN || input.threshold > THRESHOLD_MAX)
	) {
		throw new SettingsInvalid(
			`The threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}.`
		);
	}
	if (input.perClass?.loop === "reviewer" || input.perClass?.loop === "run") {
		throw new SettingsInvalid("Loops always come to you: the reviewer has no transcript.");
	}
	if (input.perClass?.secrets === "run") {
		throw new SettingsInvalid("Secrets never run without a card: choose you or the reviewer.");
	}
	const text = next.instructions.trim();
	if (text.length > INSTRUCTIONS_MAX) {
		throw new SettingsInvalid(`The instructions may be at most ${INSTRUCTIONS_MAX} characters.`);
	}
	const marker = FENCE_MARKERS.find((m) => text.includes(m));
	if (marker) {
		throw new SettingsInvalid(
			`The instructions may not contain "${marker.trim()}": it marks the fixed frame.`
		);
	}
	if (next.enabled && !next.decisionModelId) {
		throw new SettingsInvalid("Choose a decision model before turning the reviewer on.");
	}
	next.instructions = text;
	next.updatedAt = new Date();
	await collections.agentReviewUserSettings.updateOne(
		{ userId },
		{ $set: { ...next, userId } },
		{ upsert: true }
	);
	return next;
}

/** What the review service decides with: the user's settings, on only while the deployment's
 * switch is too. */
export async function effectiveReviewSettings(userId: ObjectId): Promise<AgentReviewSettings> {
	const [user, deployment] = await Promise.all([
		getUserReviewSettings(userId),
		getDeploymentReviewEnabled(),
	]);
	return { ...user, enabled: user.enabled && deployment };
}

/**
 * The per-class map an Auto session carries (ADR 0109 amendment): `run` for a class the user lets
 * run, `ask` for the rest (the reviewer's and the user's alike: who answers is decided when the
 * card arrives, so Auto never silently becomes Allow when the reviewer is off).
 */
export function autoClassMap(perClass: AgentReviewSettings["perClass"]): AutoClasses {
	const out: AutoClasses = {};
	for (const c of PERMISSION_CLASSES) {
		out[c] = c !== "loop" && c !== "secrets" && perClass[c] === "run" ? "run" : "ask";
	}
	return out;
}

export async function autoClassesFor(userId: ObjectId): Promise<AutoClasses> {
	return autoClassMap((await getUserReviewSettings(userId)).perClass);
}

export async function appendReviewLog(
	entry: Omit<AgentReviewLogEntry, "_id" | "summary" | "time"> & { summary: string; time?: Date }
): Promise<void> {
	await collections.agentReviewLog.insertOne({
		...entry,
		summary: entry.summary.slice(0, SUMMARY_MAX),
		reason: entry.reason.slice(0, 500),
		time: entry.time ?? new Date(),
	});
}

export interface ReviewLogFilters {
	/** A device id (the machine). */
	deviceId?: string;
	outcome?: ReviewOutcome;
	class?: PermissionClass;
	userId?: ObjectId;
	/** Entries older than this (the `time` of the last row of the previous page). */
	before?: Date;
	limit?: number;
}

export const REVIEW_LOG_PAGE = 50;

/** Newest first; keyset paging by `before`. */
export async function listReviewLog(
	filters: ReviewLogFilters = {}
): Promise<{ entries: AgentReviewLogEntry[]; next: Date | null }> {
	const limit = Math.min(Math.max(filters.limit ?? REVIEW_LOG_PAGE, 1), 200);
	const q: Record<string, unknown> = {};
	if (filters.deviceId) q.deviceId = filters.deviceId;
	if (filters.outcome) q.outcome = filters.outcome;
	if (filters.class) q.class = filters.class;
	if (filters.userId) q.userId = filters.userId;
	if (filters.before) q.time = { $lt: filters.before };
	const rows = await collections.agentReviewLog
		.find(q)
		.sort({ time: -1, _id: -1 })
		.limit(limit + 1)
		.toArray();
	const entries = rows.slice(0, limit);
	return { entries, next: rows.length > limit ? entries[entries.length - 1].time : null };
}

/** Whether one device's owner opted it out of the reviewer (the review service asks this per ask). */
export async function deviceOptedOut(userId: ObjectId, deviceId: string): Promise<boolean> {
	if (!ObjectId.isValid(deviceId)) return false;
	const d = await collections.codeDevices.findOne(
		{ _id: new ObjectId(deviceId), userId },
		{ projection: { neverReview: 1 } }
	);
	return d?.neverReview === true;
}

export type { ReviewAnswerer };
export function answererFor(s: AgentReviewSettings, c: PermissionClass): ReviewAnswerer {
	return c === "loop" ? "you" : s.perClass[c];
}

// -- the standard cases (a Test button, never a gate) ------------------------------------------

export interface ReviewTestCase {
	id: string;
	label: string;
	/** What the trial expects: a routine case is allowed, a must-escalate case is not. */
	expected: "allow" | "escalate";
	got: "allow" | "escalate" | "error";
	probability: number | null;
	ok: boolean;
	/** Gating cases are the ones whose expected outcome holds under any reasonable instruction;
	 * they are highlighted, and still never block a save. */
	gating?: boolean;
}
export interface ReviewTestReport {
	passed: boolean;
	cases: ReviewTestCase[];
}
export type ReviewTester = (candidate: {
	decisionModelId: string;
	threshold: number;
	instructions: string;
	token: string | undefined;
}) => Promise<ReviewTestReport>;

let tester: ReviewTester | null = null;
/** The review service registers its "standard cases" runner here. */
export function registerReviewTester(fn: ReviewTester | null): void {
	tester = fn;
}
export function reviewTester(): ReviewTester | null {
	return tester;
}

/** What the composer needs to compute its line (ADR 0109): whether Auto has a reviewer behind it
 * for this user, and the user's own per-class rows. No instructions, no model name. */
export async function autoApprovalAvailability(userId: ObjectId): Promise<{
	available: boolean;
	perClass: AgentReviewSettings["perClass"];
	/** The reviewer keeps failing: Auto's cards come to the user until it answers again. */
	degraded: boolean;
}> {
	const s = await effectiveReviewSettings(userId);
	return {
		available: autoPermissionsEnabled() && s.enabled && s.decisionModelId !== null,
		perClass: s.perClass,
		degraded: reviewerDegraded(),
	};
}
