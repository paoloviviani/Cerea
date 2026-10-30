import superjson from "superjson";
import { base } from "$app/paths";

/** `/api/v2/user/schedule-grant`: the person's background access for scheduled chats. */
export interface ScheduleGrantStatus {
	/** False off a gateway: nothing to grant. */
	required: boolean;
	granted: boolean;
	/** Whether scheduled chats are using it now (stopped in Settings: false until a schedule is turned on again). */
	active: boolean;
	chatSchedules: number;
}

export async function getScheduleGrant(): Promise<ScheduleGrantStatus> {
	const res = await fetch(`${base}/api/v2/user/schedule-grant`);
	if (!res.ok) throw new Error("Could not read the background access.");
	return superjson.parse<ScheduleGrantStatus>(await res.text());
}

export async function stopScheduleGrant(): Promise<{ disabled: number }> {
	const res = await fetch(`${base}/api/v2/user/schedule-grant`, { method: "DELETE" });
	if (!res.ok) throw new Error("Could not stop the background access.");
	return superjson.parse<{ disabled: number }>(await res.text());
}
