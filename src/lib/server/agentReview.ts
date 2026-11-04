/**
 * Agent auto-approval, server side (ADR 0107): the administrator's settings, the review log and the
 * deployment kill switch. The review service (routing, the model call) builds on these four functions.
 *
 * `CHAT_AUTO_PERMISSIONS` is the **kill switch**, shaped like `CHAT_SCHEDULES_ENABLED`: on unless
 * exactly "false". On by default because it grants nothing by itself: the reviewer stays off until an
 * administrator picks a decision model and turns it on, and the saved on/off is the real control.
 * Off: no reviewer runs, the composer's third step reads Allow and its cards come to the user.
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
		testedFingerprint: null,
	};
}

/** What the test must have covered: a change to any of these needs a new passing test. */
export function settingsFingerprint(
	s: Pick<AgentReviewSettings, "decisionModelId" | "threshold" | "instructions">
): string {
	return JSON.stringify([s.decisionModelId, s.threshold, s.instructions.trim()]);
}

/** Fills gaps and fixes what must not vary (`loop` is always "you"); never throws on stored data. */
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
		if (v === "you" || v === "reviewer") perClass[c] = v;
	}
	perClass.loop = "you";
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
		testedFingerprint: raw.testedFingerprint ?? null,
	};
}

export async function getAgentReviewSettings(): Promise<AgentReviewSettings> {
	const row = await collections.agentReviewConfig.findOne({});
	return normalize(row);
}

/**
 * Validates and stores. Throws `SettingsInvalid` with a user-facing sentence. Refuses (rather than
 * clamps) a threshold below the floor, an over-long text, fence markers, and `loop: reviewer`.
 * `testedFingerprint` is set by the caller only after a passing test.
 */
export async function saveAgentReviewSettings(
	input: Partial<Omit<AgentReviewSettings, "perClass">> & {
		perClass?: Partial<AgentReviewSettings["perClass"]>;
	},
	opts: { testedFingerprint?: string | null } = {}
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
	if (input.perClass?.loop === "reviewer") {
		throw new SettingsInvalid("Loops always come to you: the reviewer has no transcript.");
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
	next.testedFingerprint =
		opts.testedFingerprint !== undefined
			? opts.testedFingerprint
			: (input.testedFingerprint ?? null);
	await collections.agentReviewConfig.updateOne({}, { $set: next }, { upsert: true });
	return next;
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

// -- the save-time test ------------------------------------------------------------

export interface ReviewTestCase {
	id: string;
	label: string;
	/** What the trial expects: a routine case is allowed, a must-escalate case is not. */
	expected: "allow" | "escalate";
	got: "allow" | "escalate" | "error";
	probability: number | null;
	ok: boolean;
	/** Only gating cases decide whether the test passes; the others are shown (the instruction decides them). */
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
/** The review service registers its "standard cases" runner here (ADR 0107 plan item 3). */
export function registerReviewTester(fn: ReviewTester | null): void {
	tester = fn;
}
export function reviewTester(): ReviewTester | null {
	return tester;
}

/** Called by the test route after a passing run: the save of exactly these settings may now go through. */
export async function recordPassingTest(fingerprint: string): Promise<void> {
	await collections.agentReviewConfig.updateOne(
		{},
		{ $set: { testedFingerprint: fingerprint } },
		{ upsert: true }
	);
}

/** Whether saving `next` needs a passing test first (and has none). */
export function needsPassingTest(saved: AgentReviewSettings, next: AgentReviewSettings): boolean {
	if (!next.enabled || tester === null) return false;
	const fp = settingsFingerprint(next);
	// Already running on exactly these values: nothing changed, nothing to test.
	if (saved.enabled && fp === settingsFingerprint(saved)) return false;
	return saved.testedFingerprint !== fp;
}

/** The public view of the deployment's setup that composers need (no instructions). */
export async function autoApprovalAvailability(): Promise<{
	available: boolean;
	perClass: AgentReviewSettings["perClass"];
	/** The reviewer keeps failing: Auto's cards come to the user until it answers again. */
	degraded: boolean;
}> {
	const s = await getAgentReviewSettings();
	return {
		available: autoPermissionsEnabled() && s.enabled && s.decisionModelId !== null,
		perClass: s.perClass,
		degraded: reviewerDegraded(),
	};
}
