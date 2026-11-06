import type { ObjectId } from "mongodb";
import type { ProjectAgentProfile } from "$lib/types/AgentSession";

/**
 * One person's default coding-agent target for a project (ADR 0106), as stored in
 * `projectAgentProfiles`. Per (project, user) and not a field of the project: a project can be
 * shared, and a machine is one user's. The API shape is `ProjectAgentProfile`.
 */
export interface ProjectAgentProfileRow extends Omit<ProjectAgentProfile, "updatedAt"> {
	_id: ObjectId;
	projectId: ObjectId;
	userId: ObjectId;
	updatedAt: Date;
	/** Set by every save since ADR 0109 made Allow hands off: a row without it that says "allow" was
	 * saved when Allow meant Auto, and reads as Auto. */
	steps?: 2;
}
