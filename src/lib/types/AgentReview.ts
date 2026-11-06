/**
 * Agent auto-approval (ADR 0107, reshaped by ADR 0109): what each user decides about who answers a
 * machine's permission asks while a session is on Auto, and the log of what the reviewer did. The
 * administrator only switches the reviewer on for the deployment.
 */
import type { PermissionClass } from "$lib/types/machineProtocol";

/** What happens to a class in Auto (ADR 0109 amendment): it runs with no card, a decision-model
 * reviewer answers the card, or the user does. */
export type ReviewAnswerer = "run" | "reviewer" | "you";

export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
export const THRESHOLD_DEFAULT = 0.85;
export const INSTRUCTIONS_MAX = 2000;
export const MAX_PER_HOUR_DEFAULT = 300;
export const MAX_PER_HOUR_MAX = 10_000;

/** ADR 0109 amendment: edits, web, agents and tools run; commands and outside access go to the
 * reviewer; secrets come to the user; loop is fixed to the user. */
export const PER_CLASS_DEFAULTS: Record<PermissionClass, ReviewAnswerer> = {
	edit: "run",
	command: "reviewer",
	web: "run",
	outside: "reviewer",
	secrets: "you",
	agents: "run",
	tools: "run",
	loop: "you",
};

/** The deployment's one switch (ADR 0109): Auto may use a reviewer here. The other fields of the
 * stored document are the earlier deployment-level settings, kept only to seed each user's own on
 * first read. */
export interface AgentReviewDeployment {
	enabled: boolean;
}

export interface AgentReviewSettings {
	/** For a user: their own reviewer switch. */
	enabled: boolean;
	/** A gateway model of `kind: decision`; null while none is chosen. */
	decisionModelId: string | null;
	/** Allow at or above this probability (0.50 to 0.99). */
	threshold: number;
	/** The user's policy text, inside the fixed frame. */
	instructions: string;
	/** `loop` is always "you": the reviewer has no transcript. */
	perClass: Record<PermissionClass, ReviewAnswerer>;
	maxPerHourPerMachine: number;
	updatedAt?: Date;
	/** Earlier deployment-level documents carried this; nothing reads it any more. */
	testedFingerprint?: string | null;
}

/** One user's settings (collection `agentReviewUserSettings`, one per user). */
export type UserAgentReviewSettings = Omit<AgentReviewSettings, "testedFingerprint"> & {
	_id?: import("mongodb").ObjectId;
	userId: import("mongodb").ObjectId;
};

/** `read-only`: allowed by rule (a plain read), no model involved. */
export type ReviewOutcome = "allowed" | "escalated" | "error" | "read-only";

/** One decision of the reviewer. Kept 90 days. Never the full command: a capped summary. */
export interface AgentReviewLogEntry {
	_id?: import("mongodb").ObjectId;
	time: Date;
	userId: import("mongodb").ObjectId;
	deviceId: string;
	/** The machine's name as the user sees it. */
	machine: string;
	sessionId: string;
	class: PermissionClass;
	/** The command or path, capped at SUMMARY_MAX characters. */
	summary: string;
	probability: number | null;
	outcome: ReviewOutcome;
	reason: string;
	/** Whether the answer was sent to the machine and accepted. */
	applied: boolean;
	modelId: string;
}

export const SUMMARY_MAX = 300;
