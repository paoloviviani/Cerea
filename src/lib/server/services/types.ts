/**
 * The admin Services page: one row per service the deployment may use.
 *
 * A row is a health and a note *code*, never a sentence: the page turns the code
 * into words in the reader's language, and nothing here can leak a hostname or
 * an error text, because there is no field to put one in. `param` is the one
 * short value a note may carry (a model name, a count, a version), bounded.
 */

/** `unknown`: configured, but nothing here can check it. */
export type Health = "ok" | "degraded" | "down" | "off" | "unknown";

export const SERVICE_IDS = [
	"gateway",
	"extractor",
	"embedding",
	"redaction",
	"documents",
	"office",
	"fetch",
	"search",
	"image",
	"transcription",
	"mcp",
	"blobs",
	"galopin",
	"schedules",
	"mail",
	"browser",
	"local",
	"sandbox",
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export const NOTE_CODES = [
	"not_configured",
	"probe_failed",
	"timed_out",
	"catalogue_down",
	"gateway_ok",
	"gateway_degraded",
	"gateway_not_ready",
	"gateway_down",
	"extractor_ok",
	"extractor_direct",
	"extractor_missing",
	"extractor_none",
	"embedding_ok",
	"embedding_missing",
	"embedding_unset",
	"knowledge_off",
	"redaction_pattern",
	"redaction_ner",
	"redaction_degraded",
	"redaction_down",
	"documents_ok",
	"documents_down",
	"office_ok",
	"office_degraded",
	"office_down",
	"fetch_direct",
	"fetch_browser",
	"fetch_standby",
	"fetch_down",
	"search_ok",
	"search_policy",
	"search_stale",
	"search_none",
	"image_ok",
	"image_none",
	"transcription_ok",
	"transcription_none",
	"mcp_ok",
	"mcp_some_failed",
	"mcp_all_failed",
	"mcp_none",
	"mcp_unchecked",
	"blobs_gridfs",
	"blobs_s3",
	"blobs_down",
	"galopin_ok",
	"galopin_partial",
	"galopin_missing",
	"schedules_ok",
	"schedules_stalled",
	"schedules_off",
	"mail_reachable",
	"mail_down",
	"mail_elsewhere",
	"browser_ok",
	"browser_model",
	"browser_needs_connectors",
	"browser_needs_key",
	"local_ok",
	"local_none",
	"sandbox_ok",
	"sandbox_degraded",
	"sandbox_down",
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export interface ProbeResult {
	health: Health;
	note: NoteCode;
	/** One short value the note shows (a model, a count, a version). */
	param?: string;
}

export interface ServiceRow extends ProbeResult {
	id: ServiceId;
}

export interface ServicesReport {
	/** ISO time the probes ran. */
	checkedAt: string;
	/** True when this is a remembered answer rather than a fresh run. */
	cached: boolean;
	rows: ServiceRow[];
}

export const PARAM_MAX = 80;

/** A value safe to show: one line, bounded, no control characters. */
export function shortParam(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value)
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim();
	if (!text) return undefined;
	return text.length > PARAM_MAX ? `${text.slice(0, PARAM_MAX - 1)}…` : text;
}
