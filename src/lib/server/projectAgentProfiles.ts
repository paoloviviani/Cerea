/**
 * A person's default coding-agent target for a project (ADR 0106): which machine and workspace
 * `agent_start` uses in that project's chats, with what mode, model and permission word.
 * Per (project, user), never a field of the project: a project can be shared, a machine is one
 * user's. Validated like a schedule target (own paired device, the workspace exists on it);
 * the labels ("machine", "workspace") are resolved here so a list needs no live machine.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { checkOwnedTarget, workspaceNameOn } from "$lib/server/code/agentSessions";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";
import { connectorOptions, MAX_SESSION_CONNECTORS } from "$lib/server/code/sessionConnectors";
import { OpError, PERMISSION_STEPS } from "$lib/types/machineProtocol";
import type { ProjectAgentProfile, ProjectAgentProfileInput } from "$lib/types/AgentSession";
import type { ProjectAgentProfileRow } from "$lib/types/ProjectAgentProfileRow";

export const profileInputSchema = z.object({
	deviceId: z.string().min(1).max(64),
	workspaceId: z.string().min(1).max(256),
	permissionMode: z.enum(PERMISSION_STEPS as [string, ...string[]]),
	modeId: z.string().min(1).max(64).optional(),
	modelId: z.string().min(1).max(256).optional(),
	connectorKeys: z.array(z.string().min(1).max(300)).max(MAX_SESSION_CONNECTORS).optional(),
});

export function profileView(row: ProjectAgentProfileRow): ProjectAgentProfile {
	return {
		deviceId: row.deviceId,
		workspaceId: row.workspaceId,
		permissionMode: row.permissionMode,
		...(row.modeId ? { modeId: row.modeId } : {}),
		...(row.modelId ? { modelId: row.modelId } : {}),
		...(row.connectorKeys?.length ? { connectorKeys: row.connectorKeys } : {}),
		labels: row.labels,
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function getProjectAgentProfile(
	projectId: ObjectId,
	userId: ObjectId
): Promise<ProjectAgentProfileRow | null> {
	const row = await collections.projectAgentProfiles.findOne({ projectId, userId });
	// Copy-on-read (ADR 0109): a profile saved before Allow became hands off said "allow" and ran
	// under the reviewer; it must not silently loosen, so it reads as Auto until saved again.
	if (row && row.steps !== 2 && row.permissionMode === "allow") {
		return { ...row, permissionMode: "auto" };
	}
	return row;
}

/** Validate and store the caller's profile. The error text is for the caller to show. */
export async function saveProjectAgentProfile(
	projectId: ObjectId,
	userId: ObjectId,
	input: ProjectAgentProfileInput
): Promise<{ ok: true; profile: ProjectAgentProfileRow } | { ok: false; error: string }> {
	const checked = await checkOwnedTarget(userId, input);
	if (!checked.ok) return checked;
	const { device } = checked;
	const previous = await getProjectAgentProfile(projectId, userId);

	// An offline machine can be chosen, as in a schedule: it cannot be asked, so the workspace
	// name is kept from the last profile for it, and is the workspace's id otherwise.
	let workspaceLabel =
		previous && previous.deviceId === input.deviceId && previous.workspaceId === input.workspaceId
			? previous.labels.workspace
			: input.workspaceId;
	if (isMachineOnline(input.deviceId)) {
		try {
			const name = await workspaceNameOn(new MachineLink(input.deviceId), input.workspaceId);
			if (name === null) return { ok: false, error: "That workspace is not on this computer." };
			workspaceLabel = name;
		} catch (err) {
			if (!(err instanceof OpError && err.code === "unavailable")) {
				return { ok: false, error: err instanceof Error ? err.message : "The machine refused." };
			}
		}
	}

	// Every connector must be one the user could switch on for a session on this machine now.
	const connectorKeys = [...new Set(input.connectorKeys ?? [])];
	if (connectorKeys.length > 0) {
		const allowed = new Set(
			(await connectorOptions(userId, input.deviceId))
				.filter((o) => !o.unavailable)
				.map((o) => o.key)
		);
		if (connectorKeys.some((k) => !allowed.has(k))) {
			return { ok: false, error: "One of those connectors is not available to you." };
		}
	}

	const row: ProjectAgentProfileRow = {
		_id: previous?._id ?? new ObjectId(),
		projectId,
		userId,
		deviceId: input.deviceId,
		workspaceId: input.workspaceId,
		permissionMode: input.permissionMode,
		...(input.modeId ? { modeId: input.modeId } : {}),
		...(input.modelId ? { modelId: input.modelId } : {}),
		...(connectorKeys.length ? { connectorKeys } : {}),
		labels: { device: device.name, workspace: workspaceLabel },
		updatedAt: new Date(),
		steps: 2,
	};
	await collections.projectAgentProfiles.replaceOne({ projectId, userId }, row, { upsert: true });
	return { ok: true, profile: row };
}

export async function deleteProjectAgentProfile(
	projectId: ObjectId,
	userId: ObjectId
): Promise<boolean> {
	const { deletedCount } = await collections.projectAgentProfiles.deleteOne({ projectId, userId });
	return deletedCount > 0;
}
