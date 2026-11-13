import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logLine } from "../shared/http.ts";

/**
 * One audit record, with OCSF-ish fields: time, actor, activity (action), the lease, the outcome.
 * Never a command, a file name or a byte of content: only sizes, counts and a hash.
 */
export interface AuditRecord {
	action: string;
	outcome: "success" | "failure" | "denied";
	lease?: string;
	kind?: string;
	owner?: string;
	actor?: string;
	detail?: Record<string, unknown>;
}

export interface Audit {
	write(record: AuditRecord): void;
}

/** Append-only JSON Lines, to stdout and (when a path is set) a file opened for append. */
export class FileAudit implements Audit {
	private path: string;
	constructor(path: string) {
		this.path = path;
		if (path) mkdirSync(dirname(path), { recursive: true });
	}
	write(record: AuditRecord): void {
		const line = {
			time: new Date().toISOString(),
			class_name: "sandbox_lease",
			activity: record.action,
			status: record.outcome,
			actor: record.actor ?? "service",
			lease: record.lease,
			kind: record.kind,
			owner: record.owner,
			...record.detail,
		};
		const text = JSON.stringify(line) + "\n";
		process.stdout.write(`audit ${text}`);
		if (this.path) {
			try {
				appendFileSync(this.path, text, { flag: "a", mode: 0o600 });
			} catch (err) {
				logLine({ level: "error", msg: "audit file write failed", error: String(err) });
			}
		}
	}
}

export class MemoryAudit implements Audit {
	records: AuditRecord[] = [];
	write(record: AuditRecord): void {
		this.records.push(record);
	}
}
