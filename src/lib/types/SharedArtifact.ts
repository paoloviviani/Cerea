import type { ObjectId } from "mongodb";
import type { ArtifactKind } from "$lib/utils/artifacts";
import type { Conversation } from "./Conversation";
import type { User } from "./User";

/** Who may open a share link (ADR 0120). */
export type ShareAudience = "signed_in" | "anyone";

/** The expiries the dialog offers, in days; `null` is never. */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;

/**
 * What a link shows, frozen when the link was made (or last updated to the
 * latest version). A text artifact is copied: its versions are derived from the
 * conversation's messages, so there is no immutable record to point at. A file
 * (a run's or a document tool's output) is already immutable and content
 * addressed, so it is referenced by its hash and nothing is copied.
 */
export type SharedSnapshot =
	| {
			kind: "text";
			type: ArtifactKind;
			title: string;
			language?: string;
			version: number;
			content: string;
	  }
	| {
			kind: "file";
			name: string;
			mime: string;
			size: number;
			sha256: string;
			version?: number;
	  };

/**
 * One public link to a snapshot of one artifact. The token itself is never
 * stored: only its SHA-256, which is how a request finds the row.
 */
export interface SharedArtifact {
	_id: ObjectId;
	tokenHash: string;
	ownerId: User["_id"];
	/** The owner's display name when the link was made, for the band. */
	ownerName: string;
	conversationId: Conversation["_id"];
	conversationTitle: string;
	/** A text artifact's identifier, or a file's name. */
	artifactId: string;
	snapshot: SharedSnapshot;
	audience: ShareAudience;
	/** Null is never. */
	expiresAt: Date | null;
	revokedAt: Date | null;
	/** Roughly de-duplicated per viewer per day; not exact. */
	views: number;
	createdAt: Date;
	updatedAt: Date;
}

/** The one deployment-wide switch's row (`_id` is always "global"). */
export interface ShareSettings {
	_id: string;
	enabled: boolean;
	updatedAt: Date;
}
