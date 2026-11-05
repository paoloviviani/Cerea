/**
 * Agent auto-approval (ADR 0107 section 2): what the administrator decides about who answers a
 * machine's permission asks while a session is on Auto, and the log of what the reviewer did.
 */
import type { PermissionClass } from "$lib/types/machineProtocol";

/** Who answers an ask of a class in Auto: the user, or the decision-model reviewer. */
export type ReviewAnswerer = "you" | "reviewer";

export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
export const THRESHOLD_DEFAULT = 0.85;
export const INSTRUCTIONS_MAX = 2000;
export const MAX_PER_HOUR_DEFAULT = 300;
export const MAX_PER_HOUR_MAX = 10_000;

/** ADR 0107: secrets and loop come to the user; the rest only matter if a machine sets them to ask. */
export const PER_CLASS_DEFAULTS: Record<PermissionClass, ReviewAnswerer> = {
	edit: "reviewer",
	command: "reviewer",
	web: "reviewer",
	outside: "reviewer",
	secrets: "you",
	agents: "reviewer",
	tools: "reviewer",
	loop: "you",
};

export interface AgentReviewSettings {
	enabled: boolean;
	/** A gateway model of `kind: decision`; null while none is chosen. */
	decisionModelId: string | null;
	/** Allow at or above this probability (0.50 to 0.99). */
	threshold: number;
	/** The administrator's policy text, inside the fixed frame. */
	instructions: string;
	/** `loop` is always "you": the reviewer has no transcript. */
	perClass: Record<PermissionClass, ReviewAnswerer>;
	maxPerHourPerMachine: number;
	updatedAt?: Date;
	/** Fingerprint of the model, threshold and instructions that last passed "Test on the standard cases". */
	testedFingerprint?: string | null;
}

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
